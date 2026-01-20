const { getConnection } = require('../connection');

const adminRepository = {
	getAll: () => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM admins ORDER BY added_at DESC');
		return stmt.all();
	},

	getByUserId: (userId) => {
		const db = getConnection();
		const stmt = db.prepare('SELECT * FROM admins WHERE user_id = ?');
		return stmt.get(userId);
	},

	exists: (userId) => {
		const db = getConnection();
		const stmt = db.prepare('SELECT 1 FROM admins WHERE user_id = ?');
		return stmt.get(userId) !== undefined;
	},

	add: (userId, addedBy) => {
		const db = getConnection();
		const stmt = db.prepare(`
			INSERT INTO admins (user_id, added_by)
			VALUES (?, ?)
		`);
		const result = stmt.run(userId, addedBy);
		return result.lastInsertRowid;
	},

	remove: (userId) => {
		const db = getConnection();
		const stmt = db.prepare('DELETE FROM admins WHERE user_id = ?');
		return stmt.run(userId);
	},

	count: () => {
		const db = getConnection();
		const stmt = db.prepare('SELECT COUNT(*) as count FROM admins');
		return stmt.get().count;
	}
};

module.exports = adminRepository;
