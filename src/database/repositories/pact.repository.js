const { getConnection } = require('../connection');

const pactOperations = {
	createPact: (userId, name, nrp) => {
		const db = getConnection();
		const stmt = db.prepare(`
			INSERT OR REPLACE INTO pacts (user_id, name, nrp)
			VALUES (?, ?, ?)
		`);
		return stmt.run(userId, name, nrp);
	},

	getPact: (userId) => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM pacts WHERE user_id = ?');
		return stmt.get(userId);
	}
};

module.exports = pactOperations;
