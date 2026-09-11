const { getConnection } = require('../connection');

const registrationOperations = {
	registerUser: data => {
		const db = getConnection();
		const stmt = db.prepare(`
			INSERT INTO ctf_registrations (ctf_id, user_id, username, team_name, ctfd_user_id, ctfd_team_name)
			VALUES (@ctf_id, @user_id, @username, @team_name, @ctfd_user_id, @ctfd_team_name)
			ON CONFLICT(ctf_id, user_id) DO UPDATE SET
				username = @username,
				team_name = @team_name,
				ctfd_user_id = @ctfd_user_id,
				ctfd_team_name = @ctfd_team_name
		`);
		return stmt.run(data);
	},

	getRegistrationsByCTF: ctfId => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM ctf_registrations WHERE ctf_id = ? ORDER BY registered_at ASC');
		return stmt.all(ctfId);
	},

	getUserRegistration: (ctfId, userId) => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM ctf_registrations WHERE ctf_id = ? AND user_id = ?');
		return stmt.get(ctfId, userId);
	},

	/**
	 * Attach a platform account to an existing registration.
	 *
	 * Only the two platform-derived columns are touched: username and team_name
	 * are what the member typed and must not be overwritten by a sync. This is
	 * the repair path for registrations made before a platform credential was
	 * configured, which stored ctfd_user_id as NULL and could never be matched to
	 * a solve.
	 *
	 * @param {number} ctfId
	 * @param {string} userId - Discord user id
	 * @param {Object} link
	 * @param {string|number} link.ctfd_user_id - Platform user id
	 * @param {string|null} [link.ctfd_team_name] - Team name the platform reports
	 * @returns {number} Rows changed (0 when the registration does not exist)
	 */
	updatePlatformLink: (ctfId, userId, { ctfd_user_id, ctfd_team_name }) => {
		const db = getConnection();
		const stmt = db.prepare(`
			UPDATE ctf_registrations
			SET ctfd_user_id = ?, ctfd_team_name = ?
			WHERE ctf_id = ? AND user_id = ?
		`);
		// Stored as a plain string: better-sqlite3 binds a JS number as a double, so
		// an uncoerced 1706 lands in this TEXT column as '1706.0'. The synthetic
		// solve ids are built from the integer form, and matching those is the whole
		// point of the column, so the canonical form is the integer string.
		return stmt.run(String(ctfd_user_id), ctfd_team_name ?? null, ctfId, userId).changes;
	},

	getTeamMembers: (ctfId, teamName) => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM ctf_registrations WHERE ctf_id = ? AND team_name = ?');
		return stmt.all(ctfId, teamName);
	},

	deleteRegistration: (ctfId, userId) => {
		const db = getConnection();
		const stmt = db.prepare('DELETE FROM ctf_registrations WHERE ctf_id = ? AND user_id = ?');
		return stmt.run(ctfId, userId);
	}
};

module.exports = registrationOperations;
