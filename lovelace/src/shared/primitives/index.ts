/**
 * Barrel export so cards can `import '../shared/primitives/index.js'`
 * once and get all three custom elements registered as a side-effect.
 * Importing the named class is also fine — both forms register.
 */
export { EfBadge, type EfBadgeTone } from './ef-badge.js';
export { EfTile } from './ef-tile.js';
export { EfSection } from './ef-section.js';
