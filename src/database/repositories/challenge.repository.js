const { getConnection } = require('../connection');

const challengeOperations = {
	upsertChallenge: (data) => {
		const db = getConnection();
		const stmt = db.prepare(`
			INSERT INTO ctf_challenges (ctf_id, chal_name, chal_category, points, created_by)
			VALUES (@ctf_id, @chal_name, @chal_category, @points, @created_by)
			ON CONFLICT(ctf_id, chal_name) DO UPDATE SET
				points = excluded.points,
				chal_category = excluded.chal_category
		`);
		return stmt.run(data);
	},

	addChallenge: (data) => {
		const db = getConnection();
		const stmt = db.prepare(`
			INSERT INTO ctf_challenges (ctf_id, chal_name, chal_category, created_by)
			VALUES (@ctf_id, @chal_name, @chal_category, @created_by)
		`);
		const result = stmt.run(data);
		return result.lastInsertRowid;
	},

	getChallengesByCTF: (ctfId) => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM ctf_challenges WHERE ctf_id = ? ORDER BY chal_category, chal_name');
		return stmt.all(ctfId);
	},

	getChallengeByName: (ctfId, chalName) => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM ctf_challenges WHERE ctf_id = ? AND chal_name = ?');
		return stmt.get(ctfId, chalName);
	},

	markChallengeSolved: (challengeId, userId, solvedAt) => {
		const db = getConnection();
		const stmt = db.prepare(`
			INSERT INTO ctf_challenge_solves (challenge_id, user_id, solved_at)
			VALUES (?, ?, COALESCE(?, CURRENT_TIMESTAMP))
		`);
		const result = stmt.run(challengeId, userId, solvedAt || null);

		return result.lastInsertRowid;
	},

	updateChallengePoints: (challengeId, points) => {
		const db = getConnection();
		const stmt = db.prepare('UPDATE ctf_challenges SET points = ? WHERE id = ?');
		return stmt.run(points, challengeId);
	},

	getChallengeSolvers: (challengeId) => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM ctf_challenge_solves WHERE challenge_id = ? ORDER BY solved_at ASC');
		return stmt.all(challengeId);
	},

	hasUserSolved: (challengeId, userId) => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM ctf_challenge_solves WHERE challenge_id = ? AND user_id = ?');
		return stmt.get(challengeId, userId);
	},

	markChallengeSolvedForCtfdUser: (challengeId, ctfdUserId, ctfdUsername, solvedAt) => {
		const db = getConnection();
		const userId = `ctfd:${ctfdUserId}`;
		const stmt = db.prepare(`
			INSERT INTO ctf_challenge_solves (challenge_id, user_id, ctfd_username, solved_at)
			VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
		`);
		return stmt.run(challengeId, userId, ctfdUsername, solvedAt || null);
	},

	hasCtfdUserSolved: (challengeId, ctfdUserId) => {
		const db = getConnection();
		const userId = `ctfd:${ctfdUserId}`;
		const stmt = db.prepare('SELECT * FROM ctf_challenge_solves WHERE challenge_id = ? AND user_id = ?');
		return stmt.get(challengeId, userId);
	},

	transferPendingSolves: (ctfId, ctfdUserId, discordUserId) => {
		const db = getConnection();
		const pendingUserId = `ctfd:${ctfdUserId}`;

		const pendingSolves = db.prepare(`
			SELECT s.id, s.challenge_id
			FROM ctf_challenge_solves s
			JOIN ctf_challenges c ON s.challenge_id = c.id
			WHERE s.user_id = ? AND c.ctf_id = ?
		`).all(pendingUserId, ctfId);

		let transferred = 0;
		let dropped = 0;

		for (const solve of pendingSolves) {
			try {
				db.prepare('UPDATE ctf_challenge_solves SET user_id = ?, ctfd_username = NULL WHERE id = ?')
					.run(discordUserId, solve.id);
				transferred++;
			} catch (err) {
				if (err.message.includes('UNIQUE constraint')) {
					db.prepare('DELETE FROM ctf_challenge_solves WHERE id = ?').run(solve.id);
					dropped++;
				} else {
					throw err;
				}
			}
		}

		return { transferred, dropped };
	},

	deleteChallenge: (challengeId) => {
		const db = getConnection();
		const stmt = db.prepare('DELETE FROM ctf_challenges WHERE id = ?');
		return stmt.run(challengeId);
	}
};

module.exports = challengeOperations;
