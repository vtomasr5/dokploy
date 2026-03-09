import type { apiRestoreBackup } from "@dokploy/server/db/schema";
import type { Destination } from "@dokploy/server/services/destination";
import type { MySql } from "@dokploy/server/services/mysql";
import type { z } from "zod";
import { getS3Credentials } from "../backups/utils";
import { execAsyncOnTarget } from "../process/execAsync";
import { resolveSwarmServiceExecutionTarget } from "../swarm/service-target";
import { getRestoreCommand } from "./utils";

export const restoreMySqlBackup = async (
	mysql: MySql,
	destination: Destination,
	backupInput: z.infer<typeof apiRestoreBackup>,
	emit: (log: string) => void,
) => {
	try {
		const { appName, databaseRootPassword, serverId } = mysql;

		const rcloneFlags = getS3Credentials(destination);
		const bucketPath = `:s3:${destination.bucket}`;
		const backupPath = `${bucketPath}/${backupInput.backupFile}`;

		const rcloneCommand = `rclone cat ${rcloneFlags.join(" ")} "${backupPath}" | gunzip`;
		const target = await resolveSwarmServiceExecutionTarget(appName, serverId);

		const command = getRestoreCommand({
			appName,
			type: "mysql",
			credentials: {
				database: backupInput.databaseName,
				databasePassword: databaseRootPassword,
			},
			restoreType: "database",
			rcloneCommand,
			containerId: target.containerId,
		});

		emit("Starting restore...");

		emit(`Executing command: ${command}`);

		await execAsyncOnTarget(target.target, command, {
			localOptions: {
				shell: "/bin/bash",
			},
		});

		emit("Restore completed successfully!");
	} catch (error) {
		console.error(error);
		emit(
			`Error: ${
				error instanceof Error ? error.message : "Error restoring mysql backup"
			}`,
		);
		throw new Error(
			error instanceof Error ? error.message : "Error restoring mysql backup",
		);
	}
};
