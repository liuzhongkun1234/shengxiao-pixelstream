(function (root) {
	const knownReasons = new Set([
		"not_found",
		"public_access_disabled",
		"share_expired",
		"share_revoked",
		"share_online_limit",
		"public_capacity_reached",
		"share_invalid",
		"share_unavailable"
	]);

	const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

	async function check(url, options = {}) {
		const fetcher = options.fetcher || root.fetch?.bind(root);
		const sleeper = options.wait || wait;
		const delays = options.delays || [0, 750, 1500, 3000];
		if (typeof fetcher !== "function") return temporaryFailure(0);

		for (let attempt = 0; attempt < delays.length; attempt++) {
			if (delays[attempt] > 0) await sleeper(delays[attempt]);
			try {
				const response = await fetcher(url, { cache: "no-store" });
				let result = null;
				try { result = await response.json(); } catch { }
				if (result?.ok === true) return { ...result, transient: false, attempts: attempt + 1 };
				if (result?.ok === false && knownReasons.has(String(result.reason || "")))
					return { ...result, transient: false, attempts: attempt + 1 };
			} catch { }
		}

		return temporaryFailure(delays.length);
	}

	function temporaryFailure(attempts) {
		return {
			ok: false,
			transient: true,
			attempts,
			reason: "share_starting",
			message: "公网服务正在启动，系统将自动重试。"
		};
	}

	root.PeerStreamPublicShare = Object.freeze({ check });
})(globalThis);
