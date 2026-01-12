const { getConnection } = require('../connection');

const ctfOperations = {
	createCTF: (data) => {
		const db = getConnection();
		const stmt = db.prepare(`
			INSERT INTO ctfs (guild_id, channel_id, event_id, ctf_name, ctf_base_url, ctf_date, description, banner_url, api_token, created_by)
			VALUES (@guild_id, @channel_id, @event_id, @ctf_name, @ctf_base_url, @ctf_date, @description, @banner_url, @api_token, @created_by)
		`);
		const result = stmt.run(data);
		return result.lastInsertRowid;
	},

	getCTFByChannelId: (channelId) => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM ctfs WHERE channel_id = ?');
		return stmt.get(channelId);
	},

	getCTFById: (id) => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM ctfs WHERE id = ?');
		return stmt.get(id);
	},

	getCTFsByGuild: (guildId) => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM ctfs WHERE guild_id = ? ORDER BY ctf_date DESC');
		return stmt.all(guildId);
	},

	deleteCTF: (id) => {
		const db = getConnection();
		const stmt = db.prepare('DELETE FROM ctfs WHERE id = ?');
		return stmt.run(id);
	},

	archiveCTF: (channelId) => {
		const db = getConnection();
		const stmt = db.prepare('UPDATE ctfs SET archived = 1 WHERE channel_id = ?');
		return stmt.run(channelId);
	},

	unarchiveCTF: (channelId) => {
		const db = getConnection();
		const stmt = db.prepare('UPDATE ctfs SET archived = 0 WHERE channel_id = ?');
		return stmt.run(channelId);
	},

	getCTFSummaryStats: (ctfId) => {
		const db = getConnection();
		const registrations = db.prepare(`
			SELECT
				r.user_id,
				r.username,
				r.team_name,
				r.ctfd_team_name
			FROM ctf_registrations r
			WHERE r.ctf_id = ?
		`).all(ctfId);

		const userIds = registrations.map(r => r.user_id);

		const solves = userIds.length > 0
			? db.prepare(`
					SELECT
						s.user_id,
						COUNT(s.id) as solve_count,
						COALESCE(SUM(c.points), 0) as total_points
					FROM ctf_challenge_solves s
					LEFT JOIN ctf_challenges c ON s.challenge_id = c.id AND c.ctf_id = ?
					WHERE s.user_id IN (${userIds.map(() => '?').join(', ')})
					GROUP BY s.user_id
				`).all([...userIds, ...userIds.map(() => ctfId)])
			: [];

		const userIdToSolves = new Map(solves.map(s => [s.user_id, s]));

		return registrations.map(r => {
			const solveData = userIdToSolves.get(r.user_id) || { solve_count: 0, total_points: 0 };
			return {
				user_id: r.user_id,
				username: r.username,
				team_name: r.team_name,
				ctfd_team_name: r.ctfd_team_name,
				solve_count: solveData.solve_count,
				total_points: solveData.total_points
			};
		}).sort((a, b) => b.total_points - a.total_points);
	}
};

module.exports = ctfOperations;
