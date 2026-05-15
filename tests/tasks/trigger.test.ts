/* Tests for looksLikeTask() — the prefix/trigger detector used to route incoming
 * Telegram messages to the task pipeline instead of the calendar parser.
 *
 * Run: deno test tests/tasks/trigger.test.ts */

import { assertEquals } from 'jsr:@std/assert@1'
import { looksLikeTask } from '../../supabase/functions/telegram-webhook/tasks.ts'

Deno.test('explicit "задача" prefix', () => {
  assertEquals(looksLikeTask('Задача позвонить Ивану'), true)
  assertEquals(looksLikeTask('задача позвонить Ивану'), true)
  assertEquals(looksLikeTask('Задачу — позвонить Ивану'), true)
})

Deno.test('"поставь задачу" / "добавь задачу" / "запиши задачу"', () => {
  assertEquals(looksLikeTask('Поставь задачу позвонить Ивану'), true)
  assertEquals(looksLikeTask('добавь задачу купить хлеб'), true)
  assertEquals(looksLikeTask('запиши задачу проверить роутер'), true)
})

Deno.test('"напомни" with or without object', () => {
  assertEquals(looksLikeTask('Напомни мне полить цветы'), true)
  assertEquals(looksLikeTask('напомни Ивану позвонить'), true)
})

Deno.test('"не забыть" / "не забудь"', () => {
  assertEquals(looksLikeTask('Не забыть отправить перевод маме'), true)
  assertEquals(looksLikeTask('не забудь полить цветы'), true)
})

Deno.test('"надо ... сделать" / generic "надо"', () => {
  assertEquals(looksLikeTask('Надо забрать билет в Дели'), true)
})

Deno.test('strips greeting prefix', () => {
  assertEquals(looksLikeTask('Пандитджи, поставь задачу позвонить Ивану'), true)
  assertEquals(looksLikeTask('пандит джи добавь задачу купить хлеб'), true)
})

Deno.test('plain calendar event — NOT a task', () => {
  assertEquals(looksLikeTask('Завтра в 15:00 встреча с Иваном в кафе Восход'), false)
  assertEquals(looksLikeTask('Запиши встречу с врачом в понедельник'), false)
  assertEquals(looksLikeTask('Звонок с командой в среду в три'), false)
})

Deno.test('empty / noise — NOT a task', () => {
  assertEquals(looksLikeTask(''), false)
  assertEquals(looksLikeTask('   '), false)
  assertEquals(looksLikeTask('как дела?'), false)
  assertEquals(looksLikeTask('Привет, Пандитджи'), false)
})

Deno.test('case-insensitive', () => {
  assertEquals(looksLikeTask('ЗАДАЧА позвонить Ивану'), true)
  assertEquals(looksLikeTask('ПОСТАВЬ ЗАДАЧУ позвонить'), true)
})
