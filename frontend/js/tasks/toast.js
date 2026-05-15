/* Undo toast — one at a time. If a new toast appears while another is alive,
 * the previous action is finalised immediately and the new one takes over.
 *
 * `commit` is the action that locks in when the timer expires (default: noop).
 * `revert` is what runs when the user taps «Отменить». */

import { ICON_CHECK, ICON_ARROW_RIGHT } from './icons.js'

const TTL_SEC = 5

let active = null   // { el, intervalId, finalize, reverted }

const ICONS = {
  done: ICON_CHECK,
  snooze: ICON_ARROW_RIGHT,
}

export function showUndoToast({ kind, text, onCommit, onRevert }) {
  /* Finalize any existing toast first so we don't lose its commit. */
  if (active) finalizeActive(false)

  const el = document.getElementById('toast')
  if (!el) return

  let secondsLeft = TTL_SEC
  el.innerHTML = `
    <span class="icon">${ICONS[kind] ?? ICON_CHECK}</span>
    <span class="text">${escapeText(text)}</span>
    <span class="ttl">${secondsLeft}</span>
    <button class="undo" type="button">Отменить</button>
  `
  el.classList.add('show')

  const ttlEl = el.querySelector('.ttl')
  const undoBtn = el.querySelector('.undo')

  const intervalId = setInterval(() => {
    secondsLeft -= 1
    if (secondsLeft <= 0) {
      finalizeActive(false)
      return
    }
    ttlEl.textContent = String(secondsLeft)
  }, 1000)

  active = {
    el,
    intervalId,
    finalize: (reverted) => {
      clearInterval(intervalId)
      el.classList.remove('show')
      if (!reverted) onCommit?.()
      else onRevert?.()
      active = null
    },
    reverted: false,
  }

  undoBtn.addEventListener('click', () => finalizeActive(true), { once: true })
}

function finalizeActive(reverted) {
  if (!active) return
  active.finalize(reverted)
}

function escapeText(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
