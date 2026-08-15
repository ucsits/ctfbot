/**
 * Self-hosted font loading for the store posters.
 *
 * Image composition uses librsvg (via sharp), which resolves fonts through
 * the local fontconfig database. To keep the rendered layout byte-identical
 * on any server — docker container, bare VPS, CI — we ship the fonts inside
 * the repository and embed them into every SVG as `@font-face` data URIs.
 * That makes output independent of whatever fonts happen to be installed.
 *
 * The ttf files live under assets/fonts/ and are committed. If they are
 * missing (shallow clone, fresh checkout before the files landed), they are
 * provisioned from the local fontconfig database on first use, so the bot
 * still boots when the system font exists.
 */
const fs = require('fs');
const path = require('path');

const { execFileSync } = require('child_process');

// Font family names used by the poster SVG. Keep the SVG and the @font-face
// names in sync — librsvg only picks up the embedded font when `font-family`
// in the document text matches the family declared in the CSS.
const FONT_CONFIG = [
	{
		family: 'DejaVu Sans',
		file: 'DejaVuSans-Bold.ttf',
		systemName: 'dejavu sans:style=bold'
	},
	{
		family: 'DejaVu Sans',
		file: 'DejaVuSans.ttf',
		systemName: 'dejavu sans'
	}
];

/**
 * Find a font file on this machine via fc-match.
 * @param {string} pattern - fontconfig pattern, e.g. 'dejavu sans:style=bold'
 * @returns {string|undefined} absolute path to the font file
 * @private
 */
function resolveSystemFont(pattern) {
	try {
		const out = execFileSync('fc-match', ['-f', '%{file}', pattern], { encoding: 'utf8' });
		if (out && fs.existsSync(out)) {
			return out;
		}
	} catch {
		// fc-match missing or failing — fall through
	}
	return undefined;
}

/**
 * Provision every tracked font file, either from the repo or the system.
 * Called lazily on first render so the bot starts even outside a terminal.
 * @returns {Array<{family: string, file: string, ttf: Buffer}>}
 * @private
 */
let provisioned = null;
function provisionFonts() {
	if (provisioned) {
		return provisioned;
	}

	const FONT_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');
	fs.mkdirSync(FONT_DIR, { recursive: true });

	provisioned = FONT_CONFIG.map(entry => {
		const target = path.join(FONT_DIR, entry.file);
		if (!fs.existsSync(target)) {
			const source = resolveSystemFont(entry.systemName);
			if (source) {
				fs.copyFileSync(source, target);
			} else {
				console.warn(`[store-poster] font ${entry.file} not found locally; text may render with a fallback`);
			}
		}
		return {
			family: entry.family,
			file: entry.file,
			ttf: fs.existsSync(target) ? fs.readFileSync(target) : null
		};
	});

	return provisioned;
}

/**
 * Build the SVG <style> block that embeds the repo fonts as data URIs.
 * @returns {string}
 * @private
 */
function buildFontStyle() {
	const style = provisionFonts()
		.filter(font => font.ttf)
		.map(font => {
			const b64 = font.ttf.toString('base64');
			return (
				`@font-face { font-family:'${font.family}'; ` +
				`src: url(data:font/ttf;base64,${b64}) format('truetype'); }`
			);
		})
		.join('');
	return `<style>${style}</style>`;
}

/**
 * Public entry point: run a font-blob fetch.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function pingFont(interaction) {
	return interaction.reply({
		content:
			'store fonts provisioned? see server logs for warnings. font files: ' +
			provisionFonts()
				.map(f => `${f.file} (${f.ttf ? f.ttf.length : 0} bytes)`)
				.join(', ')
	});
}

module.exports = {
	buildFontStyle,
	provisionFonts,
	pingFont
};
