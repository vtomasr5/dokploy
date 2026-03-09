import path from "node:path";
import { paths } from "@dokploy/server/constants";
import { findComposeById } from "@dokploy/server/services/compose";
import type { findVolumeBackupById } from "@dokploy/server/services/volume-backups";
import { getS3Credentials, normalizeS3Path } from "../backups/utils";
import {
	type CommandExecutionTarget,
	execAsync,
	execAsyncOnTarget,
	execAsyncRemote,
} from "../process/execAsync";
import {
	resolveSwarmServiceExecutionTarget,
	resolveSwarmServiceNodeExecutionTarget,
} from "../swarm/service-target";

type VolumeBackupRecord = Awaited<ReturnType<typeof findVolumeBackupById>>;

export interface VolumeBackupExecutionContext {
	managerServerId: string | null;
	managerTarget: CommandExecutionTarget;
	dataTarget: CommandExecutionTarget;
	dataServerId: string | null;
	lockPath: string;
	serviceName: string;
	volumeBackupPath: string;
	backupFileName: string;
	rcloneCommand: string;
	composeType?: "stack" | "docker-compose";
}

export const getVolumeBackupServerId = (volumeBackup: VolumeBackupRecord) => {
	return (
		volumeBackup.application?.serverId ||
		volumeBackup.compose?.serverId ||
		volumeBackup.postgres?.serverId ||
		volumeBackup.mysql?.serverId ||
		volumeBackup.mariadb?.serverId ||
		volumeBackup.mongo?.serverId ||
		volumeBackup.redis?.serverId ||
		null
	);
};

export const getVolumeServiceAppName = (
	volumeBackup: VolumeBackupRecord,
): string => {
	if (volumeBackup.compose?.appName) {
		return volumeBackup.serviceName
			? `${volumeBackup.compose.appName}_${volumeBackup.serviceName}`
			: volumeBackup.compose.appName;
	}

	const serviceAppName =
		volumeBackup.application?.appName ||
		volumeBackup.postgres?.appName ||
		volumeBackup.mysql?.appName ||
		volumeBackup.mariadb?.appName ||
		volumeBackup.mongo?.appName ||
		volumeBackup.redis?.appName;

	return serviceAppName || volumeBackup.appName;
};

export const getVolumeManagerTarget = (serverId: string | null) => {
	if (serverId) {
		return {
			type: "server",
			serverId,
		} satisfies CommandExecutionTarget;
	}

	return {
		type: "local",
	} satisfies CommandExecutionTarget;
};

const resolveSwarmVolumeTarget = async (
	volumeBackup: VolumeBackupRecord,
	serverId: string | null,
) => {
	const swarmTarget = await resolveSwarmServiceExecutionTarget(
		getVolumeServiceAppName(volumeBackup),
		serverId,
	);

	return {
		dataTarget: swarmTarget.target,
		dataServerId: swarmTarget.serverId,
		composeType: undefined,
	} satisfies Pick<
		VolumeBackupExecutionContext,
		"dataTarget" | "dataServerId" | "composeType"
	>;
};

const resolveComposeVolumeTarget = async (
	volumeBackup: VolumeBackupRecord,
	serverId: string | null,
) => {
	const compose = await findComposeById(volumeBackup.compose?.composeId || "");

	if (compose.composeType === "stack") {
		const swarmTarget = await resolveSwarmVolumeTarget(volumeBackup, serverId);
		return {
			...swarmTarget,
			composeType: compose.composeType,
		} satisfies Pick<
			VolumeBackupExecutionContext,
			"dataTarget" | "dataServerId" | "composeType"
		>;
	}

	return {
		dataTarget: getVolumeManagerTarget(serverId),
		dataServerId: serverId,
		composeType: compose.composeType,
	} satisfies Pick<
		VolumeBackupExecutionContext,
		"dataTarget" | "dataServerId" | "composeType"
	>;
};

export const resolveVolumeBackupExecutionContext = async (
	volumeBackup: VolumeBackupRecord,
) => {
	const serverId = getVolumeBackupServerId(volumeBackup);
	const { VOLUME_BACKUPS_PATH, VOLUME_BACKUP_LOCK_PATH } = paths(!!serverId);
	const destination = volumeBackup.destination;
	const s3AppName = getVolumeServiceAppName(volumeBackup);
	const backupFileName = `${volumeBackup.volumeName}-${new Date().toISOString()}.tar`;
	const bucketDestination = `${s3AppName}/${normalizeS3Path(volumeBackup.prefix || "")}${backupFileName}`;
	const rcloneFlags = getS3Credentials(destination);
	const rcloneDestination = `:s3:${destination.bucket}/${bucketDestination}`;
	const volumeBackupPath = path.join(VOLUME_BACKUPS_PATH, volumeBackup.appName);
	const serviceName = getVolumeServiceAppName(volumeBackup);
	const lockPath = `${VOLUME_BACKUP_LOCK_PATH}-${serviceName}`;
	const managerTarget = getVolumeManagerTarget(serverId);

	const targetInfo =
		volumeBackup.serviceType === "compose"
			? await resolveComposeVolumeTarget(volumeBackup, serverId)
			: await resolveSwarmVolumeTarget(volumeBackup, serverId);

	return {
		managerServerId: serverId,
		managerTarget,
		dataTarget: targetInfo.dataTarget,
		dataServerId: targetInfo.dataServerId,
		lockPath,
		serviceName,
		volumeBackupPath,
		backupFileName,
		rcloneCommand: `rclone copyto ${rcloneFlags.join(" ")} "${volumeBackupPath}/${backupFileName}" "${rcloneDestination}"`,
		composeType: targetInfo.composeType,
	} satisfies VolumeBackupExecutionContext;
};

export const getVolumeBackupCommand = (
	volumeBackup: VolumeBackupRecord,
	context: VolumeBackupExecutionContext,
) => {
	return `
		set -e
		mkdir -p "${context.volumeBackupPath}"
		echo "Volume name: ${volumeBackup.volumeName}"
		echo "Backup file name: ${context.backupFileName}"
		echo "Turning off volume backup: ${volumeBackup.turnOff ? "Yes" : "No"}"
		echo "Starting volume backup"
		echo "Dir: ${context.volumeBackupPath}"
		docker run --rm \
			-v ${volumeBackup.volumeName}:/volume_data \
			-v "${context.volumeBackupPath}":/backup \
			ubuntu \
			bash -c "cd /volume_data && tar cvf /backup/${context.backupFileName} ."
		echo "Volume backup done ✅"
		echo "Starting upload to S3..."
		${context.rcloneCommand}
		echo "Upload to S3 done ✅"
		echo "Cleaning up local backup file..."
		rm -f "${context.volumeBackupPath}/${context.backupFileName}"
		echo "Local backup file cleaned up ✅"
	`;
};

export const getVolumeLockAcquireCommand = (lockPath: string) => {
	return `
		set -e
		LOCK_DIR="${lockPath}.dir"
		echo "Waiting for volume backup lock: ${lockPath}"
		while ! mkdir "$LOCK_DIR" 2>/dev/null; do
			echo "Waiting for volume backup lock: ${lockPath}"
			sleep 5
		done
		echo "Volume backup lock acquired"
	`;
};

export const getVolumeLockReleaseCommand = (lockPath: string) => {
	return `
		set -e
		rm -rf "${lockPath}.dir"
		echo "Volume backup lock released"
	`;
};

export const resolveComposeStackVolumeNodeTarget = async (
	stackName: string,
	volumeName: string,
	managerServerId?: string | null,
) => {
	const serviceNames = await listStackServiceNames(stackName, managerServerId);
	const matchingServices: string[] = [];

	for (const serviceName of serviceNames) {
		const mounts = await inspectServiceMounts(serviceName, managerServerId);
		const hasVolume = mounts.some(
			(mount) => mount.Type === "volume" && mount.Source === volumeName,
		);

		if (hasVolume) {
			matchingServices.push(serviceName);
		}
	}

	if (matchingServices.length > 1) {
		throw new Error(
			`Volume ${volumeName} is attached to multiple services in stack ${stackName}. Restore is ambiguous without a specific service target.`,
		);
	}

	if (matchingServices[0]) {
		return resolveSwarmServiceNodeExecutionTarget(
			matchingServices[0],
			managerServerId,
		);
	}

	throw new Error(
		`Unable to find a swarm service in stack ${stackName} using volume ${volumeName}.`,
	);
};

interface ServiceMount {
	Type?: string;
	Source?: string;
}

const listStackServiceNames = async (
	stackName: string,
	managerServerId?: string | null,
) => {
	const command = `docker stack services "${stackName}" --format '{{.Name}}'`;
	const result = managerServerId
		? await execAsyncRemote(managerServerId, command)
		: await execAsync(command);

	return result.stdout
		.split("\n")
		.map((serviceName) => serviceName.trim())
		.filter(Boolean);
};

const inspectServiceMounts = async (
	serviceName: string,
	managerServerId?: string | null,
) => {
	const command = `docker service inspect "${serviceName}" --format '{{json .Spec.TaskTemplate.ContainerSpec.Mounts}}'`;
	const result = managerServerId
		? await execAsyncRemote(managerServerId, command)
		: await execAsync(command);

	const trimmedStdout = result.stdout.trim();
	if (!trimmedStdout || trimmedStdout === "null") {
		return [] as ServiceMount[];
	}

	return JSON.parse(trimmedStdout) as ServiceMount[];
};

export const getReplicatedServiceReplicas = async (
	serviceName: string,
	managerTarget: CommandExecutionTarget,
) => {
	const { stdout } = await execAsyncOnTarget(
		managerTarget,
		`docker service inspect ${serviceName} --format '{{json .Spec.Mode.Replicated.Replicas}}'`,
	);

	const replicasValue = stdout.trim();
	if (!replicasValue || replicasValue === "null") {
		throw new Error(
			`Volume backups currently support replicated swarm services only: ${serviceName}.`,
		);
	}

	return JSON.parse(replicasValue) as number;
};

export const getComposeContainerIdForVolumeBackup = async (
	volumeBackup: VolumeBackupRecord,
) => {
	if (volumeBackup.serviceType !== "compose") {
		return null;
	}

	const compose = await findComposeById(volumeBackup.compose?.composeId || "");
	if (compose.composeType === "stack") {
		return null;
	}

	const { getComposeContainer } = await import("../docker/utils");
	const container = await getComposeContainer(
		compose,
		volumeBackup.serviceName || "",
	);
	return container?.Id || null;
};
