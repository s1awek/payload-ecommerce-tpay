/**
 * The cart carried in the `?cart=` query parameter of the demo shop.
 *
 * The parameter exists so that a cart survives the hop to the public tunnel
 * address before a payment. It arrives from a URL, which means anyone can write
 * it: a link sent to a buyer decides what this page then puts into the document.
 * The page used to drop the quantity straight into `innerHTML`, so
 * `?cart={"1":"<img src=x onerror=...>"}` ran script in the shop's origin - and
 * this origin holds the cart secret and the order access token.
 *
 * Two functions, because there are two different jobs: decide what the data may
 * look like at all, and escape whatever still ends up inside markup.
 *
 * Plain JavaScript on purpose: the browser imports this module as it is, and
 * `test/cart-param.test.js` imports the same file under plain node.
 */

/** Nobody buys a hundred demo mugs, and a cap keeps the page readable. */
export const MAX_QUANTITY = 99

/**
 * `{ productId: quantity }` with every key a positive integer identifier and
 * every value an integer from 1 to MAX_QUANTITY. Anything else is dropped
 * rather than repaired: this is a demo cart, not a document worth rescuing.
 */
export function parseCartParam(raw) {
  let parsed

  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw ?? ''))
  } catch {
    return {}
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }

  const cart = {}

  for (const [key, value] of Object.entries(parsed)) {
    // Product identifiers in this demo are numbers. A key that is not one
    // cannot match a product, so it can only be here to be printed.
    if (!/^[0-9]{1,12}$/.test(key)) {
      continue
    }

    const quantity = typeof value === 'number' ? value : Number(String(value).trim())

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      continue
    }

    cart[key] = quantity
  }

  return cart
}

const HTML_ESCAPES = {
  '"': '&quot;',
  '&': '&amp;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
}

/** Everything that goes into an HTML string goes through here first. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character])
}
