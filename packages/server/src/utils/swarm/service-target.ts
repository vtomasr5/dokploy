import {
	findServerById,
	findServerByIpAddress,
} from "@dokploy/server/services/server";
import {
	type CommandExecutionTarget,
	execAsync,
	execAsyncRemote,
	execAsyncRemoteWithConnection,
	type SshConnectionConfig,
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

interface SwarmRemoteManager {
	Addr?: string;
	NodeID?: string;
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

export interface ResolvedSwarmManagerTarget {
	target: CommandExecutionTarget;
	serverId: string | null;
	organizationId?: string;
	sshFallbackConnection?: SshConnectionConfig;
}

const execOnTarget = async (
	target: CommandExecutionTarget,
	command: string,
) => {
	if (target.type === "local") {
		return execAsync(command);
	}

	if (target.type === "server") {
		return execAsyncRemote(target.serverId, command);
	}

	return execAsyncRemoteWithConnection(target.connection, command);
};

const execOnManager = async (
	managerTarget: ResolvedSwarmManagerTarget,
	command: string,
) => {
	return execOnTarget(managerTarget.target, command);
};

const parseJsonValue = <T>(stdout: string, fallback: T): T => {
	const trimmedStdout = stdout.trim();
	if (!trimmedStdout) {
		return fallback;
	}

	try {
		return JSON.parse(trimmedStdout) as T;
	} catch {
		return fallback;
	}
};

const extractManagerHost = (address: string) => {
	const trimmedAddress = address.trim();
	if (!trimmedAddress) {
		return "";
	}

	if (trimmedAddress.startsWith("[")) {
		const endBracketIndex = trimmedAddress.indexOf("]");
		if (endBracketIndex > 1) {
			return trimmedAddress.slice(1, endBracketIndex);
		}
	}

	const colonCount = (trimmedAddress.match(/:/g) || []).length;
	if (colonCount === 1) {
		return trimmedAddress.split(":")[0] || trimmedAddress;
	}

	return trimmedAddress;
};

const getServerSshConnection = (server: {
	ipAddress: string;
	port: number;
	username: string;
	sshKey?: {
		privateKey: string;
	} | null;
}) => {
	const privateKey = server.sshKey?.privateKey;
	if (!privateKey) {
		return null;
	}

	return {
		host: server.ipAddress,
		port: server.port,
		username: server.username,
		privateKey,
	} satisfies SshConnectionConfig;
};

const isSwarmManagerTarget = async (target: CommandExecutionTarget) => {
	try {
		const { stdout } = await execOnTarget(
			target,
			"docker info --format '{{json .Swarm.ControlAvailable}}'",
		);

		return parseJsonValue<boolean>(stdout, false);
	} catch {
		return false;
	}
};

const getSwarmRemoteManagers = async (target: CommandExecutionTarget) => {
	try {
		const { stdout } = await execOnTarget(
			target,
			"docker info --format '{{json .Swarm.RemoteManagers}}'",
		);

		const remoteManagers = parseJsonValue<SwarmRemoteManager[]>(stdout, []);
		return remoteManagers
			.map((manager) => extractManagerHost(manager.Addr || ""))
			.filter(Boolean);
	} catch {
		return [] as string[];
	}
};

const uniqueHosts = (hosts: string[]) => {
	return [...new Set(hosts.map((host) => host.trim()).filter(Boolean))];
};

const resolveManagerFromHosts = async ({
	hosts,
	organizationId,
	sshFallbackConnection,
}: {
	hosts: string[];
	organizationId?: string;
	sshFallbackConnection?: SshConnectionConfig;
}) => {
	for (const host of hosts) {
		const matchedServer = organizationId
			? await findServerByIpAddress(host, organizationId)
			: await findServerByIpAddress(host);

		if (matchedServer) {
			const target = {
				type: "server",
				serverId: matchedServer.serverId,
			} satisfies CommandExecutionTarget;

			if (await isSwarmManagerTarget(target)) {
				return {
					target,
					serverId: matchedServer.serverId,
					organizationId,
					sshFallbackConnection:
						getServerSshConnection(matchedServer) || sshFallbackConnection,
				} satisfies ResolvedSwarmManagerTarget;
			}
		}
	}

	if (sshFallbackConnection?.privateKey) {
		for (const host of hosts) {
			const target = {
				type: "ssh",
				connection: {
					...sshFallbackConnection,
					host,
				},
			} satisfies CommandExecutionTarget;

			if (await isSwarmManagerTarget(target)) {
				return {
					target,
					serverId: null,
					organizationId,
					sshFallbackConnection,
				} satisfies ResolvedSwarmManagerTarget;
			}
		}
	}

	return null;
};

export const resolveSwarmManagerExecutionTarget = async (
	managerServerId?: string | null,
	organizationId?: string,
) => {
	let resolvedOrganizationId = organizationId;

	if (managerServerId) {
		const configuredServer = await findServerById(managerServerId);
		resolvedOrganizationId =
			resolvedOrganizationId || configuredServer.organizationId;

		const configuredTarget = {
			type: "server",
			serverId: managerServerId,
		} satisfies CommandExecutionTarget;
		const configuredSshConnection = getServerSshConnection(configuredServer);

		if (await isSwarmManagerTarget(configuredTarget)) {
			return {
				target: configuredTarget,
				serverId: managerServerId,
				organizationId: resolvedOrganizationId,
				sshFallbackConnection: configuredSshConnection || undefined,
			} satisfies ResolvedSwarmManagerTarget;
		}

		const managerHosts = uniqueHosts(
			await getSwarmRemoteManagers(configuredTarget),
		);

		const resolvedManager = await resolveManagerFromHosts({
			hosts: managerHosts,
			organizationId: resolvedOrganizationId,
			sshFallbackConnection: configuredSshConnection || undefined,
		});

		if (resolvedManager) {
			return resolvedManager;
		}

		throw new Error(
			`Server ${configuredServer.name} (${configuredServer.ipAddress}) is a swarm worker and no manager endpoint could be resolved. Add a manager node as a Dokploy server or ensure worker credentials can SSH into at least one manager listed by 'docker info'.`,
		);
	}

	const localTarget = {
		type: "local",
	} satisfies CommandExecutionTarget;

	if (await isSwarmManagerTarget(localTarget)) {
		return {
			target: localTarget,
			serverId: null,
			organizationId: resolvedOrganizationId,
		} satisfies ResolvedSwarmManagerTarget;
	}

	const managerHosts = uniqueHosts(await getSwarmRemoteManagers(localTarget));
	const resolvedManager = await resolveManagerFromHosts({
		hosts: managerHosts,
		organizationId: resolvedOrganizationId,
	});

	if (resolvedManager) {
		return resolvedManager;
	}

	throw new Error(
		"This Dokploy instance is running on a swarm worker node. Configure a swarm manager server in Dokploy so swarm control-plane commands can be executed.",
	);
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
	managerTarget: ResolvedSwarmManagerTarget,
) => {
	if (taskIds.length === 0) {
		return [] as SwarmTaskInspect[];
	}

	const { stdout } = await execOnManager(
		managerTarget,
		`docker inspect ${taskIds.join(" ")} --format '{{json .}}'`,
	);

	return parseJsonLines<SwarmTaskInspect>(stdout);
};

const inspectTask = async (
	taskId: string,
	managerTarget: ResolvedSwarmManagerTarget,
) => {
	const tasks = await inspectTasks([taskId], managerTarget);
	return tasks[0] || null;
};

const inspectNode = async (
	nodeId: string,
	managerTarget: ResolvedSwarmManagerTarget,
) => {
	const { stdout } = await execOnManager(
		managerTarget,
		`docker node inspect ${nodeId} --format '{{json .}}'`,
	);

	const trimmedStdout = stdout.trim();
	if (!trimmedStdout) {
		return null;
	}

	return JSON.parse(trimmedStdout) as SwarmNodeInspect;
};

const getManagerNodeId = async (managerTarget: ResolvedSwarmManagerTarget) => {
	const { stdout } = await execOnManager(
		managerTarget,
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
	managerTarget: ResolvedSwarmManagerTarget,
	organizationId?: string,
) => {
	const managerNodeId = await getManagerNodeId(managerTarget);
	if (managerNodeId && node.ID === managerNodeId) {
		return {
			target: managerTarget.target,
			serverId: managerTarget.serverId,
		} satisfies ResolvedExecutionTarget;
	}

	const nodeAddress = node.Status?.Addr;
	if (!nodeAddress) {
		throw new Error("Unable to resolve the swarm node address.");
	}

	const resolvedOrganizationId = organizationId || managerTarget.organizationId;

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

	if (managerTarget.sshFallbackConnection?.privateKey) {
		return {
			target: {
				type: "ssh",
				connection: {
					host: nodeAddress,
					port: managerTarget.sshFallbackConnection.port,
					username: managerTarget.sshFallbackConnection.username,
					privateKey: managerTarget.sshFallbackConnection.privateKey,
				},
			},
			serverId: null,
		} satisfies ResolvedExecutionTarget;
	}

	throw new Error(
		`Unable to connect to swarm node ${
			node.Description?.Hostname || nodeAddress
		} (${nodeAddress}). Add this node as a Dokploy server or make sure manager credentials can SSH to this node.`,
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
	managerTarget: ResolvedSwarmManagerTarget,
	organizationId?: string,
) => {
	const nodeId = task.NodeID;

	if (!nodeId) {
		throw new Error("The selected swarm task is not assigned to any node.");
	}

	const node = await inspectNode(nodeId, managerTarget);
	if (!node) {
		throw new Error(`Unable to inspect swarm node ${nodeId}.`);
	}

	const executionTarget = await resolveNodeExecutionTarget(
		node,
		managerTarget,
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
	managerTarget: ResolvedSwarmManagerTarget,
	organizationId?: string,
) => {
	const containerId = task.Status?.ContainerStatus?.ContainerID;

	if (!containerId) {
		throw new Error("The selected swarm task is not running on any node.");
	}

	const nodeTarget = await resolveNodeTarget(
		task,
		managerTarget,
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
	const managerTarget = await resolveSwarmManagerExecutionTarget(
		managerServerId,
		organizationId,
	);
	const resolvedOrganizationId = organizationId || managerTarget.organizationId;
	const task = await inspectTask(taskId, managerTarget);
	if (!task) {
		throw new Error(`Swarm task ${taskId} was not found.`);
	}

	return resolveTaskTarget(task, managerTarget, resolvedOrganizationId);
};

export const resolveSwarmServiceExecutionTarget = async (
	serviceName: string,
	managerServerId?: string | null,
	organizationId?: string,
) => {
	const managerTarget = await resolveSwarmManagerExecutionTarget(
		managerServerId,
		organizationId,
	);
	const resolvedOrganizationId = organizationId || managerTarget.organizationId;

	const { stdout } = await execOnManager(
		managerTarget,
		`docker service ps "${serviceName}" --filter desired-state=running --no-trunc -q`,
	);

	const taskIds = stdout
		.split("\n")
		.map((taskId) => taskId.trim())
		.filter(Boolean);

	if (taskIds.length === 0) {
		throw new Error(`No running task found for swarm service ${serviceName}.`);
	}

	const tasks = await inspectTasks(taskIds, managerTarget);
	const runningTask = getRunningTask(tasks);

	if (!runningTask) {
		throw new Error(
			`No running container found for swarm service ${serviceName}.`,
		);
	}

	return resolveTaskTarget(runningTask, managerTarget, resolvedOrganizationId);
};

export const resolveSwarmServiceNodeExecutionTarget = async (
	serviceName: string,
	managerServerId?: string | null,
	organizationId?: string,
) => {
	const managerTarget = await resolveSwarmManagerExecutionTarget(
		managerServerId,
		organizationId,
	);
	const resolvedOrganizationId = organizationId || managerTarget.organizationId;

	const { stdout } = await execOnManager(
		managerTarget,
		`docker service ps "${serviceName}" --no-trunc -q`,
	);

	const taskIds = stdout
		.split("\n")
		.map((taskId) => taskId.trim())
		.filter(Boolean);

	if (taskIds.length === 0) {
		throw new Error(`No task found for swarm service ${serviceName}.`);
	}

	const tasks = await inspectTasks(taskIds, managerTarget);
	const task = getRunningTask(tasks) || getRecentTask(tasks);

	if (!task) {
		throw new Error(
			`Unable to resolve a swarm node for service ${serviceName}.`,
		);
	}

	return resolveNodeTarget(task, managerTarget, resolvedOrganizationId);
};
