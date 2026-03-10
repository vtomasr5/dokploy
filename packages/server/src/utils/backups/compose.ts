import type { BackupSchedule } from "@dokploy/server/services/backup";
import type { Compose } from "@dokploy/server/services/compose";
import {
	createDeploymentBackup,
	updateDeployment,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import { findEnvironmentById } from "@dokploy/server/services/environment";
import { findProjectById } from "@dokploy/server/services/project";
import { sendDatabaseBackupNotifications } from "../notifications/database-backup";
import {
	type CommandExecutionTarget,
	execAsyncOnTarget,
} from "../process/execAsync";
import {
	appendDeploymentLog,
	prepareDeploymentLogOnTarget,
	syncDeploymentLogFromTarget,
} from "../swarm/deployment-log";
import { resolveSwarmServiceExecutionTarget } from "../swarm/service-target";
import { getBackupCommand, getS3Credentials, normalizeS3Path } from "./utils";

export const runComposeBackup = async (
	compose: Compose,
	backup: BackupSchedule,
) => {
	const { environmentId, name, appName } = compose;
	const environment = await findEnvironmentById(environmentId);
	const project = await findProjectById(environment.projectId);
	const { prefix, databaseType, serviceName } = backup;
	const destination = backup.destination;
	const backupFileName = `${new Date().toISOString()}.sql.gz`;
	const s3AppName = serviceName ? `${appName}_${serviceName}` : appName;
	const bucketDestination = `${s3AppName}/${normalizeS3Path(prefix)}${backupFileName}`;
	const deployment = await createDeploymentBackup({
		backupId: backup.backupId,
		title: "Compose Backup",
		description: "Compose Backup",
	});
	const managerTarget: CommandExecutionTarget = compose.serverId
		? {
				type: "server",
				serverId: compose.serverId,
			}
		: {
				type: "local",
			};
	let swarmTarget: Awaited<
		ReturnType<typeof resolveSwarmServiceExecutionTarget>
	> | null = null;

	try {
		const rcloneFlags = getS3Credentials(destination);
		const rcloneDestination = `:s3:${destination.bucket}/${bucketDestination}`;
		const rcloneCommand = `rclone rcat ${rcloneFlags.join(" ")} "${rcloneDestination}"`;

		if (compose.composeType === "stack" && !serviceName) {
			throw new Error("Compose stack backups require a service name.");
		}

		swarmTarget =
			compose.composeType === "stack"
				? await resolveSwarmServiceExecutionTarget(
						`${compose.appName}_${serviceName}`,
						compose.serverId,
						project.organizationId,
					)
				: null;

		if (swarmTarget) {
			await prepareDeploymentLogOnTarget({
				deploymentId: deployment.deploymentId,
				logPath: deployment.logPath,
				target: swarmTarget.target,
				serverId: swarmTarget.serverId,
			});
		}

		const backupCommand = getBackupCommand(
			backup,
			rcloneCommand,
			deployment.logPath,
			swarmTarget
				? {
						containerId: swarmTarget.containerId,
					}
				: undefined,
		);
		const executionTarget: CommandExecutionTarget = swarmTarget
			? swarmTarget.target
			: compose.serverId
				? {
						type: "server",
						serverId: compose.serverId,
					}
				: {
						type: "local",
					};

		await execAsyncOnTarget(executionTarget, backupCommand, {
			localOptions: {
				shell: "/bin/bash",
			},
		});

		if (swarmTarget?.target.type === "ssh" && !swarmTarget.serverId) {
			await syncDeploymentLogFromTarget({
				sourceLogPath: deployment.logPath,
				sourceTarget: swarmTarget.target,
				destinationLogPath: deployment.logPath,
				destinationTarget: managerTarget,
			});
		}

		await sendDatabaseBackupNotifications({
			applicationName: name,
			projectName: project.name,
			databaseType: getDatabaseType(databaseType),
			type: "success",
			organizationId: project.organizationId,
			databaseName: backup.database,
		});

		await updateDeploymentStatus(deployment.deploymentId, "done");
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Error message not provided";

		if (swarmTarget?.target.type === "ssh" && !swarmTarget.serverId) {
			await syncDeploymentLogFromTarget({
				sourceLogPath: deployment.logPath,
				sourceTarget: swarmTarget.target,
				destinationLogPath: deployment.logPath,
				destinationTarget: managerTarget,
			}).catch(() => undefined);
		}

		await appendDeploymentLog({
			logPath: deployment.logPath,
			target: managerTarget,
			message: `\n❌ ${errorMessage}\n`,
		}).catch(() => undefined);

		await updateDeployment(deployment.deploymentId, {
			errorMessage,
		}).catch(() => undefined);

		console.log(error);
		await sendDatabaseBackupNotifications({
			applicationName: name,
			projectName: project.name,
			databaseType: getDatabaseType(databaseType),
			type: "error",
			errorMessage,
			organizationId: project.organizationId,
			databaseName: backup.database,
		});

		await updateDeploymentStatus(deployment.deploymentId, "error");
		throw error;
	}
};

const getDatabaseType = (databaseType: BackupSchedule["databaseType"]) => {
	if (databaseType === "mongo") {
		return "mongodb";
	}
	if (databaseType === "postgres") {
		return "postgres";
	}
	if (databaseType === "mariadb") {
		return "mariadb";
	}
	if (databaseType === "mysql") {
		return "mysql";
	}
	return "mongodb";
};
