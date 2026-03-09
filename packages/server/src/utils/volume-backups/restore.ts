import path from "node:path";
import {
	findApplicationById,
	findComposeById,
	findDestinationById,
	getS3Credentials,
	paths,
} from "../..";
import type { CommandExecutionTarget } from "../process/execAsync";
import { resolveSwarmServiceNodeExecutionTarget } from "../swarm/service-target";
import {
	getVolumeManagerTarget,
	resolveComposeStackVolumeNodeTarget,
} from "./backup";

interface VolumeRestorePlan {
	command: string;
	target: CommandExecutionTarget;
}

const buildVolumeRestoreCommand = (
	volumeName: string,
	backupFileName: string,
	destination: Awaited<ReturnType<typeof findDestinationById>>,
	target: CommandExecutionTarget,
) => {
	const { VOLUME_BACKUPS_PATH } = paths(target.type !== "local");
	const volumeBackupPath = path.join(VOLUME_BACKUPS_PATH, volumeName);
	const rcloneFlags = getS3Credentials(destination);
	const bucketPath = `:s3:${destination.bucket}`;
	const backupPath = `${bucketPath}/${backupFileName}`;
	const downloadCommand = `rclone copyto ${rcloneFlags.join(" ")} "${backupPath}" "${volumeBackupPath}/${backupFileName}"`;

	return getRestoreCommand(
		volumeName,
		backupFileName,
		volumeBackupPath,
		downloadCommand,
	);
};

const getRestoreCommand = (
	volumeName: string,
	backupFileName: string,
	volumeBackupPath: string,
	downloadCommand: string,
) => {
	const baseRestoreCommand = `
	set -e
	echo "Volume name: ${volumeName}"
	echo "Backup file name: ${backupFileName}"
	echo "Volume backup path: ${volumeBackupPath}"
	echo "Downloading backup from S3..."
	mkdir -p "${volumeBackupPath}"
	${downloadCommand}
	echo "Download completed ✅"
	echo "Creating new volume and restoring data..."
	docker run --rm \
		-v ${volumeName}:/volume_data \
		-v "${volumeBackupPath}":/backup \
		ubuntu \
		bash -c "cd /volume_data && tar xvf /backup/${backupFileName}"
	echo "Volume restore completed ✅"
	`;

	return `
		set -e
		VOLUME_EXISTS=$(docker volume ls -q --filter name="^${volumeName}$" | wc -l)
		echo "Volume exists: $VOLUME_EXISTS"

		if [ "$VOLUME_EXISTS" = "0" ]; then
			echo "Volume doesn't exist, proceeding with direct restore"
			${baseRestoreCommand}
		else
			echo "Volume exists, checking for containers using it (including stopped ones)..."
			CONTAINERS_USING_VOLUME=$(docker ps -a --filter "volume=${volumeName}" --format "{{.ID}}|{{.Names}}|{{.State}}|{{.Labels}}")

			if [ -z "$CONTAINERS_USING_VOLUME" ]; then
				echo "Volume exists but no containers are using it"
				echo "Removing existing volume and proceeding with restore"
				docker volume rm ${volumeName} --force
				${baseRestoreCommand}
			else
				echo ""
				echo "⚠️  WARNING: Cannot restore volume as it is currently in use!"
				echo ""
				echo "📋 The following containers are using volume '${volumeName}':"
				echo ""
				echo "$CONTAINERS_USING_VOLUME" | while IFS='|' read container_id container_name container_state labels; do
					echo "   🐳 Container: $container_name ($container_id)"
					echo "      Status: $container_state"
					if echo "$labels" | grep -q "com.docker.swarm.service.name="; then
						SERVICE_NAME=$(echo "$labels" | grep -o "com.docker.swarm.service.name=[^,]*" | cut -d'=' -f2)
						echo "      Type: Docker Swarm Service ($SERVICE_NAME)"
					elif echo "$labels" | grep -q "com.docker.compose.project="; then
						PROJECT_NAME=$(echo "$labels" | grep -o "com.docker.compose.project=[^,]*" | cut -d'=' -f2)
						echo "      Type: Docker Compose ($PROJECT_NAME)"
					else
						echo "      Type: Regular Container"
					fi
					echo ""
				done
				echo ""
				echo "🔧 To restore this volume, please:"
				echo "   1. Stop all containers/services using this volume"
				echo "   2. Remove the existing volume: docker volume rm ${volumeName}"
				echo "   3. Run the restore operation again"
				echo ""
				echo "❌ Volume restore aborted - volume is in use"
				exit 1
			fi
		fi
	`;
};

export const restoreVolume = async (
	id: string,
	destinationId: string,
	volumeName: string,
	backupFileName: string,
	serviceType: "application" | "compose",
) => {
	const destination = await findDestinationById(destinationId);

	if (serviceType === "application") {
		const application = await findApplicationById(id);
		const target = await resolveSwarmServiceNodeExecutionTarget(
			application.appName,
			application.serverId,
		);
		const command = buildVolumeRestoreCommand(
			volumeName,
			backupFileName,
			destination,
			target.target,
		);

		return {
			command: `
				echo "=== VOLUME RESTORE FOR APPLICATION ==="
				echo "Application: ${application.appName}"
				${command}
			`,
			target: target.target,
		} satisfies VolumeRestorePlan;
	}

	const compose = await findComposeById(id);
	if (compose.composeType === "stack") {
		const target = await resolveComposeStackVolumeNodeTarget(
			compose.appName,
			volumeName,
			compose.serverId,
		);
		const command = buildVolumeRestoreCommand(
			volumeName,
			backupFileName,
			destination,
			target.target,
		);

		return {
			command: `
				echo "=== VOLUME RESTORE FOR COMPOSE ==="
				echo "Compose: ${compose.appName}"
				echo "Compose Type: ${compose.composeType}"
				${command}
			`,
			target: target.target,
		} satisfies VolumeRestorePlan;
	}

	const target = getVolumeManagerTarget(compose.serverId || null);
	const command = buildVolumeRestoreCommand(
		volumeName,
		backupFileName,
		destination,
		target,
	);

	return {
		command: `
			echo "=== VOLUME RESTORE FOR COMPOSE ==="
			echo "Compose: ${compose.appName}"
			echo "Compose Type: ${compose.composeType}"
			${command}
		`,
		target,
	} satisfies VolumeRestorePlan;
};
