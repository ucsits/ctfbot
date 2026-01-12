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
		const stmt = db.prepare(`
			SELECT
				r.user_id,
				r.username,
				r.team_name,
				r.ctfd_team_name,
				p.name as real_name,
				p.nrp,
				COUNT(s.id) as solve_count,
				COALESCE(SUM(c.points), 0) as total_points
			FROM ctf_registrations r
			LEFT JOIN pacts p ON r.user_id = p.user_id
			LEFT JOIN ctf_challenge_solves s ON s.user_id = r.user_id
			LEFT JOIN ctf_challenges c ON s.challenge_id = c.id AND c.ctf_id = r.ctf_id
			WHERE r.ctf_id = ?
			GROUP BY r.user_id
			ORDER BY total_points DESC
		`);
		return stmt.all(ctfId);
	}
};

module.exports = ctfOperations;
