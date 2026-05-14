"""Точка входа для GitHub Actions cron.

ENV:
    SUPABASE_URL          — https://intcymsjpbkyrflfcwzf.supabase.co
    SUPABASE_SERVICE_ROLE — секрет
    PANDITJI_USER_ID      — uuid Адриана
    YEARS_AHEAD           — сколько лет считать вперёд (по умолчанию 2)
    DRY_RUN               — '1' = не писать в БД, просто посчитать

Поведение:
    Для каждой локации пользователя считает [сегодня, сегодня + YEARS_AHEAD лет]
    и UPSERT'ит в vaishnava_calendar.
"""

import os
import sys
from datetime import date
from dateutil.relativedelta import relativedelta

from calculator import calculate_events, calculate_panchanga
from supabase_writer import SupabaseWriter


def main() -> int:
    url = os.environ.get('SUPABASE_URL')
    key = os.environ.get('SUPABASE_SERVICE_ROLE')
    user_id = os.environ.get('PANDITJI_USER_ID')
    years_ahead = int(os.environ.get('YEARS_AHEAD', '2'))
    dry_run = os.environ.get('DRY_RUN') == '1'

    if not url or not key or not user_id:
        sys.stderr.write('Не задан SUPABASE_URL / SUPABASE_SERVICE_ROLE / PANDITJI_USER_ID\n')
        return 2

    writer = SupabaseWriter(url, key)
    locations = writer.get_user_locations(user_id)
    if not locations:
        sys.stderr.write(f'Локации для user_id={user_id} не найдены\n')
        return 3

    today = date.today()
    end = today + relativedelta(years=years_ahead)
    print(f'Период: {today} → {end}  ({(end - today).days} дней)')
    print(f'Локаций: {len(locations)}')

    total_events = 0
    for loc in locations:
        print(f'\n=== {loc["name"]} (key={loc["key"]}, tz={loc["timezone"]}) ===')
        events = calculate_events(
            start=today,
            end=end,
            lat=float(loc['lat']),
            lon=float(loc['lon']),
            timezone=loc['timezone'],
            location_name=loc['name'],
        )
        print(f'  событий: {len(events)}')

        # Краткая сводка: сколько экадаши, сколько праздников
        by_type: dict = {}
        for e in events:
            by_type[e['event_type']] = by_type.get(e['event_type'], 0) + 1
        for t, c in sorted(by_type.items()):
            print(f'    {t}: {c}')

        # Панчанга + астро (per-day)
        panchanga = calculate_panchanga(
            start=today,
            end=end,
            lat=float(loc['lat']),
            lon=float(loc['lon']),
            timezone=loc['timezone'],
            location_name=loc['name'],
        )
        print(f'  панчанга-строк: {len(panchanga)}')

        if dry_run:
            print('  DRY_RUN=1 — пропускаю запись')
        else:
            n = writer.upsert_events(user_id, loc['id'], events)
            print(f'  UPSERT vaishnava_calendar: {n}')
            n_p = writer.upsert_panchanga(user_id, loc['id'], panchanga)
            print(f'  UPSERT vaishnava_panchanga: {n_p}')
            total_events += n

    print(f'\nИтого: {total_events} записей в календаре')
    return 0


if __name__ == '__main__':
    sys.exit(main())
