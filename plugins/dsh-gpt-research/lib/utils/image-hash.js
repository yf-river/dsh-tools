/**
 * Image fingerprinting.
 *
 * One-to-one port of `gpt_researcher/scraper/utils.py:get_image_hash`: the
 * filename plus the `url` query-parameter values, hashed with MD5 hex. Used to
 * drop duplicate images that CDNs serve under different hosts.
 *
 * `crypto.createHash('md5')` is the Node equivalent of `hashlib.md5`. The
 * source returned `""` on any error so callers using the result as a dict key
 * would not crash; the same guard is kept.
 *
 * @module @yf-river/dsh-gpt-research/utils/image-hash
 */

import { createHash } from 'node:crypto'

const logger = {
  error: (...args) => console.error(...args),
}

/**
 * Calculate a fingerprint from an image URL's filename and `url` query values.
 *
 * @param {string} imageUrl - the image URL.
 * @returns {string} MD5 hex digest, or `""` when the URL cannot be parsed.
 */
export function getImageHash(imageUrl) {
  try {
    const parsed = new URL(imageUrl)
    const filename = parsed.pathname.split('/').pop() ?? ''
    // Essential query parameters (e.g. `url` for CDN-served images).
    const essentialParams = parsed.searchParams.getAll('url')
    const imageIdentifier = filename + essentialParams.join('')
    return createHash('md5').update(imageIdentifier, 'utf8').digest('hex')
  } catch (error) {
    logger.error(`Error calculating image hash for ${imageUrl}: ${error?.message ?? error}`)
    return ''
  }
}
