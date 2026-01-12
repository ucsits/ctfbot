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

	markChallengeSolved: (challengeId, userId) => {
		const db = getConnection();
		const stmt = db.prepare(`
			INSERT INTO ctf_challenge_solves (challenge_id, user_id)
			VALUES (?, ?)
		`);
		const result = stmt.run(challengeId, userId);

		const updateStmt = db.prepare(`
			UPDATE ctf_challenges
			SET solved = 1
			WHERE id = ?
		`);
		updateStmt.run(challengeId);

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

	deleteChallenge: (challengeId) => {
		const db = getConnection();
		const stmt = db.prepare('DELETE FROM ctf_challenges WHERE id = ?');
		return stmt.run(challengeId);
	}
};

module.exports = challengeOperations;
