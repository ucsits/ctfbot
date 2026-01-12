const { getConnection } = require('../connection');

const registrationOperations = {
	registerUser: (data) => {
		const db = getConnection();
		const stmt = db.prepare(`
			INSERT INTO ctf_registrations (ctf_id, user_id, username, ctfd_user_id, ctfd_team_name)
			VALUES (@ctf_id, @user_id, @username, @ctfd_user_id, @ctfd_team_name)
			ON CONFLICT(ctf_id, user_id) DO UPDATE SET
				username = @username,
				ctfd_user_id = @ctfd_user_id,
				ctfd_team_name = @ctfd_team_name
		`);
		return stmt.run(data);
	},

	getRegistrationsByCTF: (ctfId) => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM ctf_registrations WHERE ctf_id = ? ORDER BY registered_at ASC');
		return stmt.all(ctfId);
	},

	getUserRegistration: (ctfId, userId) => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM ctf_registrations WHERE ctf_id = ? AND user_id = ?');
		return stmt.get(ctfId, userId);
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
