import path from "node:path";
import { paths } from "@dokploy/server/constants";
import {
	createDeploymentVolumeBackup,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import { findVolumeBackupById } from "@dokploy/server/services/volume-backups";
import {
	execAsync,
	execAsyncOnTarget,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { scheduledJobs, scheduleJob } from "node-schedule";
import { getS3Credentials, normalizeS3Path } from "../backups/utils";
import { sendVolumeBackupNotifications } from "../notifications/volume-backup";
import { appendDeploymentLog } from "../swarm/deployment-log";
import {
	getComposeContainerIdForVolumeBackup,
	getReplicatedServiceReplicas,
	getVolumeBackupCommand,
	getVolumeBackupServerId,
	getVolumeLockAcquireCommand,
	getVolumeLockReleaseCommand,
	getVolumeManagerTarget,
	getVolumeServiceAppName,
	resolveVolumeBackupExecutionContext,
} from "./backup";

// Helper functions to extract project info from volume backup
const getProjectName = (
	volumeBackup: Awaited<ReturnType<typeof findVolumeBackupById>>,
): string => {
	const services = [
		volumeBackup.application,
		volumeBackup.compose,
		volumeBackup.postgres,
		volumeBackup.mysql,
		volumeBackup.mariadb,
		volumeBackup.mongo,
		volumeBackup.redis,
	];

	for (const service of services) {
		if (service?.environment?.project?.name) {
			return service.environment.project.name;
		}
	}

	return "Unknown Project";
};

const getOrganizationId = (
	volumeBackup: Awaited<ReturnType<typeof findVolumeBackupById>>,
): string => {
	const services = [
		volumeBackup.application,
		volumeBackup.compose,
		volumeBackup.postgres,
		volumeBackup.mysql,
		volumeBackup.mariadb,
		volumeBackup.mongo,
		volumeBackup.redis,
	];

	for (const service of services) {
		if (service?.environment?.project?.organizationId) {
			return service.environment.project.organizationId;
		}
	}

	return "";
};

export const scheduleVolumeBackup = async (volumeBackupId: string) => {
	const volumeBackup = await findVolumeBackupById(volumeBackupId);
	scheduleJob(volumeBackupId, volumeBackup.cronExpression, async () => {
		await runVolumeBackup(volumeBackupId);
	});
};

export const removeVolumeBackupJob = async (volumeBackupId: string) => {
	const currentJob = scheduledJobs[volumeBackupId];
	currentJob?.cancel();
};

const cleanupOldVolumeBackups = async (
	volumeBackup: Awaited<ReturnType<typeof findVolumeBackupById>>,
	serverId?: string | null,
) => {
	const { keepLatestCount, destination, prefix, volumeName } = volumeBackup;

	if (!keepLatestCount) return;

	try {
		const rcloneFlags = getS3Credentials(destination);
		const s3AppName = getVolumeServiceAppName(volumeBackup);
		const backupFilesPath = `:s3:${destination.bucket}/${s3AppName}/${normalizeS3Path(prefix || "")}`;
		const listCommand = `rclone lsf ${rcloneFlags.join(" ")} --include \"${volumeName}-*.tar\" ${backupFilesPath}`;
		const sortAndPick = `sort -r | tail -n +$((${keepLatestCount}+1)) | xargs -I{}`;
		const deleteCommand = `rclone delete ${rcloneFlags.join(" ")} ${backupFilesPath}{}`;
		const fullCommand = `${listCommand} | ${sortAndPick} ${deleteCommand}`;

		if (serverId) {
			await execAsyncRemote(serverId, fullCommand);
		} else {
			await execAsync(fullCommand);
		}
	} catch (error) {
		console.error("Volume backup retention error", error);
	}
};

export const runVolumeBackup = async (volumeBackupId: string) => {
	const volumeBackup = await findVolumeBackupById(volumeBackupId);
	const serverId = getVolumeBackupServerId(volumeBackup);
	const deployment = await createDeploymentVolumeBackup({
		volumeBackupId: volumeBackup.volumeBackupId,
		title: "Volume Backup",
		description: "Volume Backup",
	});
	const projectName = getProjectName(volumeBackup);
	const organizationId = getOrganizationId(volumeBackup);
	const logTarget = getVolumeManagerTarget(serverId);
	const appendLog = async (message: string) => {
		await appendDeploymentLog({
			logPath: deployment.logPath,
			target: logTarget,
			message,
		});
	};

	const runLoggedCommand = async (
		target: Parameters<typeof execAsyncOnTarget>[0],
		command: string,
	) => {
		try {
			const result = await execAsyncOnTarget(target, command, {
				localOptions: {
					shell: "/bin/bash",
				},
			});

			if (result.stdout) {
				await appendLog(result.stdout);
			}

			if (result.stderr) {
				await appendLog(result.stderr);
			}

			return result;
		} catch (error) {
			if (error instanceof Error) {
				const execError = error as Error & {
					stdout?: string;
					stderr?: string;
				};

				if (execError.stdout) {
					await appendLog(execError.stdout).catch(() => undefined);
				}

				if (execError.stderr) {
					await appendLog(execError.stderr).catch(() => undefined);
				}
			}

			throw error;
		}
	};

	let context: Awaited<
		ReturnType<typeof resolveVolumeBackupExecutionContext>
	> | null = null;
	let lockAcquired = false;
	let serviceRestartCommand = "";
	try {
		context = await resolveVolumeBackupExecutionContext(volumeBackup);

		if (volumeBackup.turnOff) {
			await runLoggedCommand(
				context.managerTarget,
				getVolumeLockAcquireCommand(context.lockPath),
			);
			lockAcquired = true;

			if (
				volumeBackup.serviceType === "compose" &&
				context.composeType === "docker-compose"
			) {
				const composeContainerId =
					await getComposeContainerIdForVolumeBackup(volumeBackup);

				if (!composeContainerId) {
					throw new Error(
						`Unable to find compose container for volume backup ${volumeBackup.name}.`,
					);
				}

				await appendLog("Stopping compose container\n");
				await runLoggedCommand(
					context.managerTarget,
					`docker stop ${composeContainerId}`,
				);
				serviceRestartCommand = `docker start ${composeContainerId}`;
			} else {
				const replicas = await getReplicatedServiceReplicas(
					context.serviceName,
					context.managerTarget,
				);

				await appendLog(
					`Stopping swarm service ${context.serviceName} to 0 replicas\n`,
				);
				await runLoggedCommand(
					context.managerTarget,
					`docker service update --replicas=0 ${context.serviceName}`,
				);
				serviceRestartCommand = `docker service update --replicas=${replicas} --with-registry-auth ${context.serviceName}`;
			}
		}

		await appendLog("Starting volume backup\n");
		await runLoggedCommand(
			context.dataTarget,
			getVolumeBackupCommand(volumeBackup, context),
		);

		if (serviceRestartCommand) {
			await appendLog(`Restarting service ${context.serviceName}\n`);
			await runLoggedCommand(context.managerTarget, serviceRestartCommand);
			serviceRestartCommand = "";
		}

		if (lockAcquired) {
			await runLoggedCommand(
				context.managerTarget,
				getVolumeLockReleaseCommand(context.lockPath),
			);
			lockAcquired = false;
		}

		if (volumeBackup.keepLatestCount && volumeBackup.keepLatestCount > 0) {
			await cleanupOldVolumeBackups(volumeBackup, serverId);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");

		// Map service type to match notification function expectations
		const mappedServiceType =
			volumeBackup.serviceType === "mongo"
				? "mongodb"
				: volumeBackup.serviceType;

		try {
			await sendVolumeBackupNotifications({
				projectName,
				applicationName: volumeBackup.name,
				volumeName: volumeBackup.volumeName,
				serviceType: mappedServiceType,
				type: "success",
				organizationId,
			});
		} catch (notificationError) {
			console.error(
				"Failed to send volume backup success notification",
				notificationError,
			);
		}
	} catch (error) {
		const { VOLUME_BACKUPS_PATH } = paths(!!serverId);
		const volumeBackupPath = path.join(
			VOLUME_BACKUPS_PATH,
			volumeBackup.appName,
		);
		// delete all the .tar files
		const command = `rm -rf ${volumeBackupPath}/*.tar`;
		if (context) {
			await execAsyncOnTarget(context.dataTarget, command, {
				localOptions: {
					shell: "/bin/bash",
				},
			}).catch(() => undefined);
		} else if (serverId) {
			await execAsyncRemote(serverId, command).catch(() => undefined);
		} else {
			await execAsync(command).catch(() => undefined);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");

		// Send error notification
		const mappedServiceType =
			volumeBackup.serviceType === "mongo"
				? "mongodb"
				: volumeBackup.serviceType;

		try {
			await sendVolumeBackupNotifications({
				projectName,
				applicationName: volumeBackup.name,
				volumeName: volumeBackup.volumeName,
				serviceType: mappedServiceType,
				type: "error",
				organizationId,
				errorMessage: error instanceof Error ? error.message : String(error),
			});
		} catch (notificationError) {
			console.error(
				"Failed to send volume backup error notification",
				notificationError,
			);
		}
	} finally {
		if (context && serviceRestartCommand) {
			await appendLog(`Restarting service ${context.serviceName}\n`).catch(
				() => undefined,
			);
			await runLoggedCommand(
				context.managerTarget,
				serviceRestartCommand,
			).catch(async (restartError) => {
				await appendLog(
					`Failed to restart service: ${
						restartError instanceof Error
							? restartError.message
							: String(restartError)
					}\n`,
				).catch(() => undefined);
			});
		}

		if (context && lockAcquired) {
			await runLoggedCommand(
				context.managerTarget,
				getVolumeLockReleaseCommand(context.lockPath),
			).catch(() => undefined);
		}
	}
};
