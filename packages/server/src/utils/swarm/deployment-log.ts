import { promises as fs } from "node:fs";
import path from "node:path";
import { updateDeployment } from "@dokploy/server/services/deployment";
import {
	type CommandExecutionTarget,
	execAsyncOnTarget,
} from "../process/execAsync";

interface PrepareDeploymentLogOptions {
	deploymentId: string;
	logPath: string;
	target: CommandExecutionTarget;
	serverId?: string | null;
}

interface AppendDeploymentLogOptions {
	logPath: string;
	target: CommandExecutionTarget;
	message: string;
}

interface SyncDeploymentLogOptions {
	sourceLogPath: string;
	sourceTarget: CommandExecutionTarget;
	destinationLogPath: string;
	destinationTarget: CommandExecutionTarget;
}

export const prepareDeploymentLogOnTarget = async ({
	deploymentId,
	logPath,
	target,
	serverId,
}: PrepareDeploymentLogOptions) => {
	const logDirectory = path.dirname(logPath);

	await execAsyncOnTarget(
		target,
		`mkdir -p "${logDirectory}" && touch "${logPath}"`,
	);

	if (serverId) {
		await updateDeployment(deploymentId, {
			serverId,
		});
	}
};

export const appendDeploymentLog = async ({
	logPath,
	target,
	message,
}: AppendDeploymentLogOptions) => {
	if (!message) {
		return;
	}

	if (target.type === "local") {
		await fs.mkdir(path.dirname(logPath), { recursive: true });
		await fs.appendFile(logPath, message);
		return;
	}

	const encodedMessage = Buffer.from(message).toString("base64");

	await execAsyncOnTarget(
		target,
		`printf '%s' '${encodedMessage}' | base64 -d >> "${logPath}"`,
	);
};

export const syncDeploymentLogFromTarget = async ({
	sourceLogPath,
	sourceTarget,
	destinationLogPath,
	destinationTarget,
}: SyncDeploymentLogOptions) => {
	const { stdout } = await execAsyncOnTarget(
		sourceTarget,
		`if [ -f "${sourceLogPath}" ]; then cat "${sourceLogPath}"; fi`,
		{
			localOptions: {
				shell: "/bin/bash",
			},
		},
	);

	if (!stdout) {
		return;
	}

	await appendDeploymentLog({
		logPath: destinationLogPath,
		target: destinationTarget,
		message: stdout,
	});
};
