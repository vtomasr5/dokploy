import {
	findServerById,
	findServerByIpAddress,
} from "@dokploy/server/services/server";
import {
	type CommandExecutionTarget,
	execAsync,
	execAsyncRemote,
} from "../process/execAsync";

interface SwarmTaskInspect {
	ID: string;
	NodeID?: string;
	DesiredState?: string;
	Status?: {
		State?: string;
		Message?: string;
		ContainerStatus?: {
			ContainerID?: string;
		};
	};
}

interface SwarmNodeInspect {
	ID: string;
	Description?: {
		Hostname?: string;
	};
	Status?: {
		Addr?: string;
	};
}

interface ResolvedExecutionTarget {
	target: CommandExecutionTarget;
	serverId: string | null;
}

export interface ResolvedSwarmNodeTarget {
	nodeId: string;
	nodeAddress: string;
	nodeHostname: string;
	currentState: string;
	target: CommandExecutionTarget;
	serverId: string | null;
}

export interface ResolvedSwarmServiceTarget {
	taskId: string;
	containerId: string;
	nodeId: string;
	nodeAddress: string;
	nodeHostname: string;
	currentState: string;
	target: CommandExecutionTarget;
	serverId: string | null;
}

const execOnManager = async (
	managerServerId: string | null | undefined,
	command: string,
) => {
	if (managerServerId) {
		return execAsyncRemote(managerServerId, command);
	}

	return execAsync(command);
};

const parseJsonLines = <T>(stdout: string): T[] => {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as T);
};

const inspectTasks = async (
	taskIds: string[],
	managerServerId: string | null | undefined,
) => {
	if (taskIds.length === 0) {
		return [] as SwarmTaskInspect[];
	}

	const { stdout } = await execOnManager(
		managerServerId,
		`docker inspect ${taskIds.join(" ")} --format '{{json .}}'`,
	);

	return parseJsonLines<SwarmTaskInspect>(stdout);
};

const inspectTask = async (
	taskId: string,
	managerServerId: string | null | undefined,
) => {
	const tasks = await inspectTasks([taskId], managerServerId);
	return tasks[0] || null;
};

const inspectNode = async (
	nodeId: string,
	managerServerId: string | null | undefined,
) => {
	const { stdout } = await execOnManager(
		managerServerId,
		`docker node inspect ${nodeId} --format '{{json .}}'`,
	);

	const trimmedStdout = stdout.trim();
	if (!trimmedStdout) {
		return null;
	}

	return JSON.parse(trimmedStdout) as SwarmNodeInspect;
};

const getManagerNodeId = async (managerServerId: string | null | undefined) => {
	const { stdout } = await execOnManager(
		managerServerId,
		"docker info --format '{{json .Swarm.NodeID}}'",
	);

	const trimmedStdout = stdout.trim();
	if (!trimmedStdout) {
		return "";
	}

	return JSON.parse(trimmedStdout) as string;
};

const resolveNodeExecutionTarget = async (
	node: SwarmNodeInspect,
	managerServerId: string | null | undefined,
	organizationId?: string,
) => {
	const managerNodeId = await getManagerNodeId(managerServerId);
	if (managerNodeId && node.ID === managerNodeId) {
		const resolvedTarget: ResolvedExecutionTarget = managerServerId
			? {
					target: {
						type: "server",
						serverId: managerServerId,
					},
					serverId: managerServerId,
				}
			: {
					target: {
						type: "local",
					},
					serverId: null,
				};

		return resolvedTarget;
	}

	const nodeAddress = node.Status?.Addr;
	if (!nodeAddress) {
		throw new Error("Unable to resolve the swarm node address.");
	}

	let resolvedOrganizationId = organizationId;
	let managerServer: Awaited<ReturnType<typeof findServerById>> | null = null;

	if (managerServerId) {
		managerServer = await findServerById(managerServerId);
		resolvedOrganizationId = managerServer.organizationId;
	}

	const matchedServer = resolvedOrganizationId
		? await findServerByIpAddress(nodeAddress, resolvedOrganizationId)
		: await findServerByIpAddress(nodeAddress);

	if (matchedServer) {
		return {
			target: {
				type: "server",
				serverId: matchedServer.serverId,
			},
			serverId: matchedServer.serverId,
		} satisfies ResolvedExecutionTarget;
	}

	if (managerServer?.sshKey?.privateKey) {
		return {
			target: {
				type: "ssh",
				connection: {
					host: nodeAddress,
					port: managerServer.port,
					username: managerServer.username,
					privateKey: managerServer.sshKey.privateKey,
				},
			},
			serverId: null,
		} satisfies ResolvedExecutionTarget;
	}

	throw new Error(
		`Unable to connect to swarm node ${
			node.Description?.Hostname || nodeAddress
		} (${nodeAddress}). Add this node as a Dokploy server or make sure it uses the same SSH credentials as the manager node.`,
	);
};

const getRunningTask = (tasks: SwarmTaskInspect[]) => {
	return (
		tasks.find(
			(task) =>
				task.DesiredState === "running" &&
				task.Status?.State === "running" &&
				Boolean(task.Status?.ContainerStatus?.ContainerID),
		) || null
	);
};

const getRecentTask = (tasks: SwarmTaskInspect[]) => {
	return tasks.find((task) => Boolean(task.NodeID)) || null;
};

const resolveNodeTarget = async (
	task: SwarmTaskInspect,
	managerServerId: string | null | undefined,
	organizationId?: string,
) => {
	const nodeId = task.NodeID;

	if (!nodeId) {
		throw new Error("The selected swarm task is not assigned to any node.");
	}

	const node = await inspectNode(nodeId, managerServerId);
	if (!node) {
		throw new Error(`Unable to inspect swarm node ${nodeId}.`);
	}

	const executionTarget = await resolveNodeExecutionTarget(
		node,
		managerServerId,
		organizationId,
	);

	return {
		nodeId,
		nodeAddress: node.Status?.Addr || "",
		nodeHostname: node.Description?.Hostname || node.Status?.Addr || nodeId,
		currentState: task.Status?.State || "unknown",
		target: executionTarget.target,
		serverId: executionTarget.serverId,
	} satisfies ResolvedSwarmNodeTarget;
};

const resolveTaskTarget = async (
	task: SwarmTaskInspect,
	managerServerId: string | null | undefined,
	organizationId?: string,
) => {
	const containerId = task.Status?.ContainerStatus?.ContainerID;

	if (!containerId) {
		throw new Error("The selected swarm task is not running on any node.");
	}

	const nodeTarget = await resolveNodeTarget(
		task,
		managerServerId,
		organizationId,
	);

	return {
		taskId: task.ID,
		containerId,
		...nodeTarget,
	} satisfies ResolvedSwarmServiceTarget;
};

export const resolveSwarmTaskExecutionTarget = async (
	taskId: string,
	managerServerId?: string | null,
	organizationId?: string,
) => {
	const task = await inspectTask(taskId, managerServerId);
	if (!task) {
		throw new Error(`Swarm task ${taskId} was not found.`);
	}

	return resolveTaskTarget(task, managerServerId, organizationId);
};

export const resolveSwarmServiceExecutionTarget = async (
	serviceName: string,
	managerServerId?: string | null,
	organizationId?: string,
) => {
	const { stdout } = await execOnManager(
		managerServerId,
		`docker service ps "${serviceName}" --filter desired-state=running --no-trunc -q`,
	);

	const taskIds = stdout
		.split("\n")
		.map((taskId) => taskId.trim())
		.filter(Boolean);

	if (taskIds.length === 0) {
		throw new Error(`No running task found for swarm service ${serviceName}.`);
	}

	const tasks = await inspectTasks(taskIds, managerServerId);
	const runningTask = getRunningTask(tasks);

	if (!runningTask) {
		throw new Error(
			`No running container found for swarm service ${serviceName}.`,
		);
	}

	return resolveTaskTarget(runningTask, managerServerId, organizationId);
};

export const resolveSwarmServiceNodeExecutionTarget = async (
	serviceName: string,
	managerServerId?: string | null,
	organizationId?: string,
) => {
	const { stdout } = await execOnManager(
		managerServerId,
		`docker service ps "${serviceName}" --no-trunc -q`,
	);

	const taskIds = stdout
		.split("\n")
		.map((taskId) => taskId.trim())
		.filter(Boolean);

	if (taskIds.length === 0) {
		throw new Error(`No task found for swarm service ${serviceName}.`);
	}

	const tasks = await inspectTasks(taskIds, managerServerId);
	const task = getRunningTask(tasks) || getRecentTask(tasks);

	if (!task) {
		throw new Error(
			`Unable to resolve a swarm node for service ${serviceName}.`,
		);
	}

	return resolveNodeTarget(task, managerServerId, organizationId);
};
