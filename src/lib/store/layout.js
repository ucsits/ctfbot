/**
 * Store imagery layout helpers.
 *
 * All canvases are composed as SVG and rasterized by sharp (librsvg). Headless
 * linux servers typically have no fontconfig, so every SVG embeds the
 * repository fonts via @font-face data URIs (see ./fonts.js) — layout is
 * reproducible on any machine.
 *
 * IMPORTANT: Discord renders embed images at ~400px wide (it scales the whole
 * image down). So the canvas is drawn at a modest width (800px ≈ 2x display)
 * with large fonts, guaranteeing text stays readable after Discord shrinks it.
 *
 * Two kinds of output:
 *   - catalog: one tall canvas, one section per item. Each section shows the
 *     item name + price header, then all of its photos in a row (or a
 *     "[no image]" placeholder). Every store item appears, in the same order
 *     as the text listing.
 *   - gallery poster: one canvas per item showing all photos for the
 *     buy/purchase embeds.
 */

const fs = require('fs');
const sharp = require('sharp');
const path = require('path');
const { buildFontStyle } = require('./fonts');

const ASSET_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'store');

// Canvas width ≈ 2x Discord's ~400px embed render, so nothing gets lost in
// the downscale. Fonts are sized generously for the same reason.
const CONTAINER_W = 800;

const PAD = 36;
const GAP = 14;
// Gap between grid cells (rows and columns) — generous so the tiles breathe.
const CELL_GAP = 32;
// Layout metrics for a single catalog grid cell.
const PHOTO_H = 190;
const HEADER_Y = 52; // item name baseline within the cell
const PRICE_Y = 88; // price baseline within the cell
const PHOTO_TOP = 108; // top of the photo row within the cell

// Placeholder colors — light enough to read on the dark canvas.
const PANEL_FILL = '#2A2C44';
const PANEL_STROKE = '#4A4E70';
const PANEL_TEXT = '#9AA1BE';

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
 * @param {number} height - canvas height
 * @returns {string}
 */
function wrapSvg(inner, height) {
	return (
		'<svg xmlns="http://www.w3.org/2000/svg" width="' +
		CONTAINER_W +
		'" height="' +
		height +
		'">' +
		buildFontStyle() +
		inner +
		'</svg>'
	);
}

/**
 * Layout one item's cell within the catalog canvas: a header line with the
 * name + price, then a photo row containing every photo (or a placeholder).
 * @param {object} item - store item row {name, ap_price, rp_price}
 * @param {Array<string>} photos - absolute paths to the item's photos
 * @param {number} x - left of this item's cell
 * @param {number} y - top of this item's cell
 * @param {number} w - cell width
 * @returns {string} SVG fragment for this cell
 */
function catalogCellSvg(item, photos, x, y, w) {
	const name = xmlEscape(item.name);
	const price = `${item.ap_price} AP · Rp ${item.rp_price.toLocaleString('id-ID')}`;

	const photoW = w - GAP * (photos.length - 1);
	const cellW = Math.floor(photoW / Math.max(photos.length, 1));
	const rowW = w;

	// Header: name (bold, left, smaller) then price (regular, right).
	const header =
		`<text x='${x}' y='${y + HEADER_Y}' ${FONT_BOLD} font-size='28' fill='#FFFFFF'>${name}</text>` +
		`<text x='${x + 4}' y='${y + PRICE_Y}' ${FONT_REGULAR} font-size='22' fill='#8A93A6'>${price}</text>`;

	let row = '';
	if (photos.length === 0) {
		// "[no image]" text only — no box, centered in the photo area.
		row = `<text x='${x + rowW / 2}' y='${y + PHOTO_TOP + PHOTO_H / 2 + 10}' text-anchor='middle' ${FONT_REGULAR} font-size='26' fill='${PANEL_TEXT}'>[no image]</text>`;
	} else {
		// Photos fill the cell, exactly one row per item (up to the width).
		photos.forEach((photo, i) => {
			const px = x + i * (cellW + GAP);
			row += `<image x='${px}' y='${y + PHOTO_TOP}' width='${cellW}' height='${PHOTO_H}' preserveAspectRatio='xMidYMid meet' href='${imageDataUri(photo)}'/>`;
		});
	}

	return header + row;
}

/**
 * Build the catalog canvas: a landscape 2-column grid of item cells, one per
 * store item. Highest-priced items sit in the first row (Jacket, Shirt),
 * cheaper ones below (Sticker, Keychain) — the classic merch poster layout.
 * @param {Array<object>} items
 * @returns {string} SVG markup
 */
function catalogGridSvg(items) {
	const cols = 2;
	const cellW = (CONTAINER_W - PAD * 2 - CELL_GAP * (cols - 1)) / cols;
	const rowH = 250;
	const rows = Math.ceil(items.length / cols);
	// PAD on top + PAD under the last row + a little breathing room so the
	// bottom cell never touches the canvas edge.
	const height = rows * (rowH + CELL_GAP) + PAD * 2 + 20 - CELL_GAP;

	// Order the grid by price descending (Jacket, Shirt on top; Sticker,
	// Keychain below). The text listing keeps its own order.
	const ordered = [...items].sort((a, b) => b.rp_price - a.rp_price);

	const cells = ordered.map((item, i) => {
		const col = i % cols;
		const row = Math.floor(i / cols);
		const x = PAD + col * (cellW + CELL_GAP);
		const y = PAD + row * (rowH + CELL_GAP);
		return catalogCellSvg(item, getStoreGallery(item.slug), x, y, cellW);
	});

	return wrapSvg(cells.join(''), height);
}

/**
 * Render the catalog canvas to a PNG buffer.
 * @param {Array<object>} items
 * @returns {Promise<Buffer>}
 */
async function renderCatalogImage(items) {
	return sharp(Buffer.from(catalogGridSvg(items)))
		.png()
		.toBuffer();
}

/**
 * Layout one item's photos into a full-width poster canvas (buy/purchase embeds).
 * @param {object} item - store item row {name, ap_price, rp_price, ...}
 * @param {Array<string>} photos - absolute paths to the item's photos
 * @returns {string} SVG markup
 */
function galleryPosterSvg(item, photos) {
	const src = idx => imageDataUri(photos[idx]);

	const n = photos.length || 1;
	const cellW = Math.floor((CONTAINER_W - PAD * 2 - GAP * (n - 1)) / n);
	const cellH = 320;
	const headerTop = PAD + cellH + 28;

	let panels = '';
	if (photos.length === 0) {
		// No photos on disk for this item yet: centered placeholder panel.
		panels =
			`<rect x='${PAD}' y='${PAD}' width='${CONTAINER_W - PAD * 2}' height='${cellH}' rx='20' fill='${PANEL_FILL}' stroke='${PANEL_STROKE}' stroke-width='3'/>` +
			`<text x='${CONTAINER_W / 2}' y='${PAD + cellH / 2}' text-anchor='middle' ${FONT_REGULAR} font-size='30' fill='${PANEL_TEXT}'>[no image]</text>`;
	} else {
		// All photos in one row; each gets an equal slice of the width.
		photos.forEach((photo, i) => {
			const x = PAD + i * (cellW + GAP);
			panels += `<image x='${x}' y='${PAD}' width='${cellW}' height='${cellH}' preserveAspectRatio='xMidYMid meet' href='${src(i)}'/>`;
		});
	}

	const header =
		`<text x='${PAD}' y='${headerTop}' ${FONT_BOLD} font-size='36' fill='#FFFFFF'>${xmlEscape(item.name)}</text>` +
		`<text x='${PAD}' y='${headerTop + 42}' ${FONT_REGULAR} font-size='24' fill='#8A93A6'>` +
		`${item.ap_price} AP · Rp ${item.rp_price.toLocaleString('id-ID')}</text>`;

	return wrapSvg(panels + header, headerTop + 80);
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

module.exports = {
	renderCatalogImage,
	renderGalleryPoster,
	getStoreGallery,
	catalogGridSvg,
	catalogCellSvg,
	galleryPosterSvg,
	wrapSvg
};
