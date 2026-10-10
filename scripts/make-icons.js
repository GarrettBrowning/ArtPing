// Draws ArtPing's favicon and social-sharing image from the site's colors.
//
//   npm run icons
//
// Writes: public/favicon.svg, public/favicon-32.png, public/apple-touch-icon.png,
//         public/images/og-image.png (the picture shown when a link is shared)
// To change the look, edit the colors or shapes below and run the command again.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PUBLIC = path.join(__dirname, '..', 'public');
const INK = '#1a1a1a';   // --ink
const PAPER = '#f5f3f0'; // --bg

// The mark: a letter "A" drawn as strokes, with a small "ping" dot.
// `corner` rounds the square (0 for the Apple icon, which iOS rounds itself).
function iconSvg(size, corner = 14) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">
  <rect width="64" height="64" rx="${corner}" fill="${INK}"/>
  <g fill="none" stroke="${PAPER}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17 49 L32 15 L47 49"/>
    <path d="M23.5 38 H40.5"/>
  </g>
  <circle cx="49" cy="15" r="4.5" fill="${PAPER}"/>
</svg>`;
}

// 1200x630 is the standard size for link previews on social sites and chat apps
function shareImageSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${PAPER}"/>
  <g transform="translate(120 205) scale(3.2)">
    <rect width="64" height="64" rx="14" fill="${INK}"/>
    <g fill="none" stroke="${PAPER}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17 49 L32 15 L47 49"/>
      <path d="M23.5 38 H40.5"/>
    </g>
    <circle cx="49" cy="15" r="4.5" fill="${PAPER}"/>
  </g>
  <text x="380" y="300" font-family="Cormorant Garamond, Georgia, 'Times New Roman', serif" font-size="150" font-weight="600" fill="${INK}">ArtPing</text>
  <text x="384" y="375" font-family="Jost, 'Segoe UI', Arial, sans-serif" font-size="38" fill="#6b6b6b">A place for artists to share their work.</text>
</svg>`;
}

async function main() {
  fs.mkdirSync(path.join(PUBLIC, 'images'), { recursive: true });
  fs.writeFileSync(path.join(PUBLIC, 'favicon.svg'), iconSvg(64) + '\n');
  await sharp(Buffer.from(iconSvg(256)), { density: 300 }).resize(32, 32).png().toFile(path.join(PUBLIC, 'favicon-32.png'));
  await sharp(Buffer.from(iconSvg(512, 0)), { density: 300 }).resize(180, 180).png().toFile(path.join(PUBLIC, 'apple-touch-icon.png'));
  await sharp(Buffer.from(shareImageSvg())).png().toFile(path.join(PUBLIC, 'images', 'og-image.png'));
  console.log('Wrote favicon.svg, favicon-32.png, apple-touch-icon.png and images/og-image.png in public/');
}

main().catch(error => { console.error(error); process.exit(1); });
