import type { BackupSchedule } from "@dokploy/server/services/backup";
import {
	createDeploymentBackup,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import { findEnvironmentById } from "@dokploy/server/services/environment";
import type { Mariadb } from "@dokploy/server/services/mariadb";
import { findProjectById } from "@dokploy/server/services/project";
import { sendDatabaseBackupNotifications } from "../notifications/database-backup";
import {
	type CommandExecutionTarget,
	execAsyncOnTarget,
} from "../process/execAsync";
import {
	prepareDeploymentLogOnTarget,
	syncDeploymentLogFromTarget,
} from "../swarm/deployment-log";
import { resolveSwarmServiceExecutionTarget } from "../swarm/service-target";
import { getBackupCommand, getS3Credentials, normalizeS3Path } from "./utils";

export const runMariadbBackup = async (
	mariadb: Mariadb,
	backup: BackupSchedule,
) => {
	const { environmentId, name, appName } = mariadb;
	const environment = await findEnvironmentById(environmentId);
	const project = await findProjectById(environment.projectId);
	const { prefix } = backup;
	const destination = backup.destination;
	const backupFileName = `${new Date().toISOString()}.sql.gz`;
	const bucketDestination = `${appName}/${normalizeS3Path(prefix)}${backupFileName}`;
	const deployment = await createDeploymentBackup({
		backupId: backup.backupId,
		title: "MariaDB Backup",
		description: "MariaDB Backup",
	});
	const managerTarget: CommandExecutionTarget = mariadb.serverId
		? {
				type: "server",
				serverId: mariadb.serverId,
			}
		: {
				type: "local",
			};
	let target: Awaited<
		ReturnType<typeof resolveSwarmServiceExecutionTarget>
	> | null = null;
	try {
		const rcloneFlags = getS3Credentials(destination);
		const rcloneDestination = `:s3:${destination.bucket}/${bucketDestination}`;
		const rcloneCommand = `rclone rcat ${rcloneFlags.join(" ")} "${rcloneDestination}"`;
		target = await resolveSwarmServiceExecutionTarget(
			mariadb.appName,
			mariadb.serverId,
			project.organizationId,
		);

		await prepareDeploymentLogOnTarget({
			deploymentId: deployment.deploymentId,
			logPath: deployment.logPath,
			target: target.target,
			serverId: target.serverId,
		});

		const backupCommand = getBackupCommand(
			backup,
			rcloneCommand,
			deployment.logPath,
			{
				containerId: target.containerId,
			},
		);

		await execAsyncOnTarget(target.target, backupCommand, {
			localOptions: {
				shell: "/bin/bash",
			},
		});

		if (target.target.type === "ssh" && !target.serverId) {
			await syncDeploymentLogFromTarget({
				sourceLogPath: deployment.logPath,
				sourceTarget: target.target,
				destinationLogPath: deployment.logPath,
				destinationTarget: managerTarget,
			});
		}

		await sendDatabaseBackupNotifications({
			applicationName: name,
			projectName: project.name,
			databaseType: "mariadb",
			type: "success",
			organizationId: project.organizationId,
			databaseName: backup.database,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
	} catch (error) {
		if (target?.target.type === "ssh" && !target.serverId) {
			await syncDeploymentLogFromTarget({
				sourceLogPath: deployment.logPath,
				sourceTarget: target.target,
				destinationLogPath: deployment.logPath,
				destinationTarget: managerTarget,
			}).catch(() => undefined);
		}

		console.log(error);
		await sendDatabaseBackupNotifications({
			applicationName: name,
			projectName: project.name,
			databaseType: "mariadb",
			type: "error",
			// @ts-ignore
			errorMessage: error?.message || "Error message not provided",
			organizationId: project.organizationId,
			databaseName: backup.database,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		throw error;
	}
};
