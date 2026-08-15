/**
 * Store imagery layout helpers.
 *
 * All canvases are composed as SVG and rasterized by sharp (librsvg). Headless
 * linux servers typically have no fontconfig, so every SVG embeds the
 * repository fonts via @font-face data URIs (see ./fonts.js) — layout is
 * reproducible on any machine.
 *
 * Three kinds of output:
 *   - silhouettes: one combined canvas stacking each item's hero image, used
 *     as the catalog embed thumbnail so the store listing is visual without
 *     sending a file per item.
 *   - gallery posters: one canvas per item showing all of its photos side by
 *     side, used inside the buy/purchase embeds.
 *   - catalog cards: per-item name + price chips, laid out in a grid, used as
 *     the embed thumbnail when an item has no real photos yet.
 */

const fs = require('fs');
const sharp = require('sharp');
const path = require('path');
const { buildFontStyle } = require('./fonts');

const ASSET_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'store');

// Canvas geometry used by every poster — small enough to ship as one Discord
// attachment, big enough to read at Discord's 160px thumbnail render.
const CONTAINER_W = 1600;
const CONTAINER_H = 900;
const PAD = 60;
const GAP = 30;
// Silhouette canvas is square to fit a Discord embed thumbnail.
const SILH_W = 1024;
const SILH_H = 1024;
const SILH_PAD = 48;
const SILH_GAP = 24;

const FONT_FAMILY = 'DejaVu Sans';
const FONT_REGULAR = `font-family='${FONT_FAMILY}'`;
const FONT_BOLD = `font-family='${FONT_FAMILY}' font-weight='bold'`;

// Escape XML so item names from the DB can never break out of the SVG or
// inject markup into the poster.
function xmlEscape(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * Resolve the local file paths for a store item's full gallery.
 * @param {string} slug
 * @returns {Array<string>} absolute paths (empty when the item has none)
 */
function getStoreGallery(slug) {
	// Image registry lives in the store command module; resolve it lazily to
	// avoid a circular require.
	const { STORE_IMAGES } = require('../../commands/store');
	const entry = STORE_IMAGES[slug];
	if (!entry) {
		return [];
	}
	return entry.gallery.map(file => path.join(ASSET_DIR, slug, file));
}

/**
 * Read a local image and return it as a data URI for embedding in SVG.
 * librsvg's bundled build refuses file:// hrefs, so photos are inlined.
 * @param {string} file - absolute path to the image
 * @returns {string}
 */
function imageDataUri(file) {
	const mime = /\.(jpe?g)$/i.test(file) ? 'image/jpeg' : /webp/i.test(file) ? 'image/webp' : 'image/png';
	const buf = fs.readFileSync(file);
	return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * Build the SVG document string for a composed canvas.
 * @param {string} inner - body of the <svg> element
 * @returns {string}
 */
function wrapSvg(inner) {
	return (
		'<svg xmlns="http://www.w3.org/2000/svg" width="' +
		CONTAINER_W +
		'" height="' +
		CONTAINER_H +
		'">' +
		buildFontStyle() +
		inner +
		'</svg>'
	);
}

/**
 * Layout one item's gallery into a full-width poster canvas.
 * @param {object} item - store item row {name, ap_price, rp_price, slug, ...}
 * @param {Array<string>} photos - absolute paths to the item's photos
 * @returns {string} SVG markup
 */
function galleryPosterSvg(item, photos) {
	const src = idx => imageDataUri(photos[idx]);

	const n = photos.length || 1;
	// Panels fill the full width; the last row may hold fewer photos and
	// center them under the header.
	const cellW = Math.floor((CONTAINER_W - PAD * 2 - GAP * (n - 1)) / n);
	const cellH = CONTAINER_H - PAD * 2 - 150;

	let panels = '';
	const rowBottom = PAD + cellH;
	if (photos.length === 0) {
		// No photos on disk for this item yet: centered placeholder panel.
		panels =
			`<rect x='${PAD}' y='${PAD}' width='${CONTAINER_W - PAD * 2}' height='${cellH}' rx='24' fill='#24253A'/>` +
			`<text x='${CONTAINER_W / 2}' y='${PAD + cellH / 2}' text-anchor='middle' ${FONT_REGULAR} font-size='36' fill='#8A93A6'>No photos yet</text>`;
	} else if (n === 1) {
		panels += `<image x='${PAD}' y='${PAD}' width='${cellW}' height='${cellH}' preserveAspectRatio='xMidYMid meet' href='${src(0)}'/>`;
	} else {
		const firstRow = Math.ceil(n / 2);
		for (let i = 0; i < n; i++) {
			const col = i % firstRow;
			const row = Math.floor(i / firstRow);
			const rowCount = row === 0 ? firstRow : n - firstRow;
			const w = Math.floor((CONTAINER_W - PAD * 2 - GAP * (rowCount - 1)) / rowCount);
			const x = PAD + col * (w + GAP);
			const y = PAD + row * (cellH / 2 + GAP * 0.5);
			panels += `<image x='${x}' y='${y}' width='${w}' height='${cellH / 2}' preserveAspectRatio='xMidYMid meet' href='${src(i)}'/>`;
		}
	}

	const titleY = rowBottom + 40;
	const priceY = rowBottom + 96;
	const header =
		`<text x='${PAD}' y='${titleY}' ${FONT_BOLD} font-size='44' fill='#FFFFFF'>${xmlEscape(item.name)}</text>` +
		`<text x='${PAD}' y='${priceY}' ${FONT_REGULAR} font-size='32' fill='#B8C0CC'>` +
		`${item.ap_price} AP · Rp ${item.rp_price.toLocaleString('id-ID')}</text>`;

	return wrapSvg(panels + header);
}

/**
 * Render a composed gallery poster to a PNG buffer.
 * @param {object} item
 * @param {Array<string>} photos - absolute paths to the item's photos
 * @returns {Promise<Buffer>}
 */
async function renderGalleryPoster(item, photos) {
	return sharp(Buffer.from(galleryPosterSvg(item, photos)))
		.png()
		.toBuffer();
}

/**
 * PNG buffer for the catalog silhouette (all items' hero images stacked),
 * or a card grid fallback when an item has no photos.
 * @param {Array<object>} items
 * @returns {Promise<Buffer>}
 */
async function renderCatalogImage(items) {
	if (items.length === 0) {
		// Empty catalog: draw a neutral placeholder canvas so the embed still
		// has a visual thumb rather than a broken attachment.
		return sharp(Buffer.from(silhouetteSvg([])))
			.png()
			.toBuffer();
	}
	const withPhotos = items.filter(item => getStoreGallery(item.slug).length > 0);
	if (withPhotos.length > 0) {
		return sharp(Buffer.from(silhouetteSvg(withPhotos)))
			.png()
			.toBuffer();
	}
	return sharp(Buffer.from(cardGridSvg(items)))
		.png()
		.toBuffer();
}

/**
 * Build the silhouette canvas SVG for the given items with photos.
 * @param {Array<object>} items
 * @returns {string}
 */
function silhouetteSvg(items) {
	const n = items.length;
	const cellW = Math.floor((SILH_W - SILH_PAD * 2 - SILH_GAP * (n - 1)) / n);
	const cellH = SILH_H - SILH_PAD * 2;

	let inner = '';
	items.forEach((item, i) => {
		const photos = getStoreGallery(item.slug);
		const img = photos.length > 0 ? photos[0] : null;
		const x = SILH_PAD + i * (cellW + SILH_GAP);
		if (img) {
			inner += `<image x='${x}' y='${SILH_PAD}' width='${cellW}' height='${cellH}' preserveAspectRatio='xMidYMid meet' href='${imageDataUri(img)}'/>`;
		} else {
			// No photo for this item yet: neutral panel with the item name.
			inner += `<rect x='${x}' y='${SILH_PAD}' width='${cellW}' height='${cellH}' fill='#24253A' rx='16'/>`;
		}
	});

	return wrapSvg(inner);
}

/**
 * Build the card-grid SVG fallback (used when no item has photos) — one card
 * per item with name and price chip.
 * @param {Array<object>} items
 * @returns {string}
 */
function cardGridSvg(items) {
	const COLS = 2;
	const rows = Math.ceil(items.length / COLS);
	const cardW = (CONTAINER_W - PAD * 2 - GAP * (COLS - 1)) / COLS;
	const cardH = (CONTAINER_H - PAD * 2 - GAP * (rows - 1)) / rows;

	let inner = '';
	items.forEach((item, i) => {
		const col = i % COLS;
		const row = Math.floor(i / COLS);
		const x = PAD + col * (cardW + GAP);
		const y = PAD + row * (cardH + GAP);
		inner +=
			`<rect x='${x}' y='${y}' width='${cardW}' height='${cardH}' rx='24' fill='#24253A'/>` +
			`<text x='${x + 40}' y='${y + cardH / 2 - 12}' ${FONT_BOLD} font-size='42' fill='#FFFFFF'>${xmlEscape(item.name)}</text>` +
			`<text x='${x + 40}' y='${y + cardH / 2 + 40}' ${FONT_REGULAR} font-size='30' fill='#B8C0CC'>${item.ap_price} AP · Rp ${item.rp_price.toLocaleString('id-ID')}</text>`;
	});
	return wrapSvg(inner);
}

module.exports = {
	renderCatalogImage,
	renderGalleryPoster,
	getStoreGallery,
	galleryPosterSvg,
	silhouetteSvg,
	cardGridSvg,
	wrapSvg
};
