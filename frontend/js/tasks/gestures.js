/* Touch swipes on .task cards inside .swipe-wrap.
 *
 * Threshold: 60px past start = action commits.
 *   right swipe → "Выполнено" (done)
 *   left  swipe → "На завтра" (snooze +1)
 *
 * Below threshold, the card springs back to 0. We bind once on the #app container
 * via delegation so newly rendered rows pick up gestures automatically. */

const COMMIT_PX = 60
const LOCK_AXIS_PX = 8       // movement on Y > this → cancel as scroll
const MAX_TRAVEL_PX = 280    // visual cap

let activeGesture = null

export function installGestures({ onComplete, onSnooze }) {
  const root = document.getElementById('app')
  if (!root) return

  root.addEventListener('touchstart', (e) => {
    const wrap = e.target.closest('.swipe-wrap')
    if (!wrap) return
    /* Ignore swipes that start on the .check, .arrow — these are explicit tap targets. */
    if (e.target.closest('[data-action="toggle-check"], [data-action="snooze-open"]')) return

    const task = wrap.querySelector('.task')
    if (!task) return

    const t = e.touches[0]
    activeGesture = {
      wrap, task,
      startX: t.clientX, startY: t.clientY,
      lastX: t.clientX,
      locked: false, cancelled: false,
      direction: 0,
    }
  }, { passive: true })

  root.addEventListener('touchmove', (e) => {
    if (!activeGesture) return
    const g = activeGesture
    if (g.cancelled) return

    const t = e.touches[0]
    const dx = t.clientX - g.startX
    const dy = t.clientY - g.startY

    if (!g.locked) {
      if (Math.abs(dy) > LOCK_AXIS_PX && Math.abs(dy) > Math.abs(dx)) {
        /* Vertical scroll wins — abandon the swipe. */
        g.cancelled = true
        resetCard(g.task, g.wrap)
        return
      }
      if (Math.abs(dx) < LOCK_AXIS_PX) return
      g.locked = true
    }

    /* Block native scroll once we own the gesture. */
    e.preventDefault()

    g.direction = dx > 0 ? 1 : -1
    g.lastX = t.clientX

    const travel = clamp(dx, -MAX_TRAVEL_PX, MAX_TRAVEL_PX)
    g.task.style.transition = 'none'
    g.task.style.transform = `translateX(${travel}px)`

    const right = g.wrap.querySelector('.swipe-reveal.right')
    const left  = g.wrap.querySelector('.swipe-reveal.left')
    right.hidden = travel <= 0
    left.hidden  = travel >= 0
  }, { passive: false })

  root.addEventListener('touchend', () => {
    if (!activeGesture) return
    const g = activeGesture
    activeGesture = null
    if (g.cancelled || !g.locked) {
      resetCard(g.task, g.wrap)
      return
    }

    const dx = g.lastX - g.startX
    if (dx >= COMMIT_PX) {
      commit(g, 'done', onComplete)
    } else if (dx <= -COMMIT_PX) {
      commit(g, 'snooze', onSnooze)
    } else {
      resetCard(g.task, g.wrap)
    }
  })

  root.addEventListener('touchcancel', () => {
    if (!activeGesture) return
    resetCard(activeGesture.task, activeGesture.wrap)
    activeGesture = null
  })
}

function commit(g, action, callback) {
  const id = g.wrap.dataset.id
  const dir = action === 'done' ? 1 : -1
  g.task.style.transition = 'transform 0.22s ease, opacity 0.22s ease'
  g.task.style.transform = `translateX(${dir * window.innerWidth * 0.6}px)`
  g.task.style.opacity = '0'

  setTimeout(() => {
    callback?.(id)
    /* Card stays in the DOM only momentarily; render() will reflow once the
     * state mutation propagates. We don't undo the inline styles — the next
     * renderPage() replaces the section's innerHTML. */
  }, 220)
}

function resetCard(task, wrap) {
  task.style.transition = 'transform 0.22s ease'
  task.style.transform = ''
  task.style.opacity = ''
  if (wrap) {
    wrap.querySelector('.swipe-reveal.right')?.setAttribute('hidden', '')
    wrap.querySelector('.swipe-reveal.left')?.setAttribute('hidden', '')
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
