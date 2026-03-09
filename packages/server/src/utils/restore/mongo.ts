import type { apiRestoreBackup } from "@dokploy/server/db/schema";
import type { Destination } from "@dokploy/server/services/destination";
import type { Mongo } from "@dokploy/server/services/mongo";
import type { z } from "zod";
import { getS3Credentials } from "../backups/utils";
import { execAsyncOnTarget } from "../process/execAsync";
import { resolveSwarmServiceExecutionTarget } from "../swarm/service-target";
import { getRestoreCommand } from "./utils";

export const restoreMongoBackup = async (
	mongo: Mongo,
	destination: Destination,
	backupInput: z.infer<typeof apiRestoreBackup>,
	emit: (log: string) => void,
) => {
	try {
		const { appName, databasePassword, databaseUser, serverId } = mongo;

		const rcloneFlags = getS3Credentials(destination);
		const bucketPath = `:s3:${destination.bucket}`;
		const backupPath = `${bucketPath}/${backupInput.backupFile}`;
		const rcloneCommand = `rclone copy ${rcloneFlags.join(" ")} "${backupPath}"`;
		const target = await resolveSwarmServiceExecutionTarget(appName, serverId);

		const command = getRestoreCommand({
			appName,
			type: "mongo",
			credentials: {
				database: backupInput.databaseName,
				databaseUser,
				databasePassword,
			},
			restoreType: "database",
			rcloneCommand,
			backupFile: backupInput.backupFile,
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
				error instanceof Error ? error.message : "Error restoring mongo backup"
			}`,
		);
		throw new Error(
			error instanceof Error ? error.message : "Error restoring mongo backup",
		);
	}
};
