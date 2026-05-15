"""Обёртка над gaurabda. Возвращает список событий за период для одной локации.

События — это нормализованные dict'ы, готовые к UPSERT'у в vaishnava_calendar.
"""

from datetime import datetime, date, timedelta
from typing import List, Dict, Optional
import math

import gaurabda
from gaurabda import GCTimeZone, GCMoonData, GCStrings

from name_map import translate, subtitle_for, translate_tithi, translate_masa, translate_naksatra


# Маппинг IANA-имён часовых поясов в формат gaurabda.
# gaurabda хранит зоны как «+3:00 Europe/Moscow», а старые IANA-имена
# («Asia/Kolkata» переименована в «Asia/Calcutta» внутри gaurabda).
_TZ_OVERRIDE = {
    'Asia/Kolkata': '+5:30 Asia/Calcutta',
    'Europe/Moscow': '+3:00 Europe/Moscow',
}

# eparana_type → строка, понятная человеку
_PARAN_REASONS = {
    0: 'none',
    1: '3day',
    2: '4tithi_end',
    3: 'naksatra_end',
    4: 'sunrise',
    5: 'tithi_end',
}

CALCULATED_BY = 'gaurabda-0.8.4'


def _find_gaurabda_tz(iana: str) -> str:
    """Вернёт строку из gaurabda-формата, на которую он отзовётся."""
    if iana in _TZ_OVERRIDE:
        return _TZ_OVERRIDE[iana]
    # Линейный поиск по суффиксу: «+5:30 Asia/Kolkata» закончится на iana.
    for z in gaurabda.GetTimeZones():
        if z.endswith(iana):
            return z
    raise ValueError(f'Часовой пояс не найден в gaurabda: {iana}')


def _build_location(name: str, lat: float, lon: float, tz_iana: str) -> gaurabda.GCLocation:
    return gaurabda.GCLocation({
        'name': name,
        'latitude': lat,
        'longitude': lon,
        'tzname': _find_gaurabda_tz(tz_iana),
    })


def _hour_decimal_to_iso(d: date, h: float, tz_offset_hours: float) -> str:
    """Десятичные часы локального времени → ISO с указанным offset.
    h может быть >= 24 (значит сдвиг на следующий день)."""
    days_offset = int(h // 24)
    h = h - days_offset * 24
    hh = int(h)
    mm_f = (h - hh) * 60
    mm = int(mm_f)
    ss = int(round((mm_f - mm) * 60))
    if ss == 60:
        ss = 0
        mm += 1
    if mm == 60:
        mm = 0
        hh += 1
    target_date = d + timedelta(days=days_offset)
    sign = '+' if tz_offset_hours >= 0 else '-'
    abs_off = abs(tz_offset_hours)
    off_h = int(abs_off)
    off_m = int(round((abs_off - off_h) * 60))
    return f'{target_date.isoformat()}T{hh:02d}:{mm:02d}:{ss:02d}{sign}{off_h:02d}:{off_m:02d}'


def _gctime_to_decimal(t) -> float:
    """gaurabda GCTime → десятичные часы (0..24)."""
    return t.hour + t.min / 60.0 + t.sec / 3600.0


def calculate_events(
    start: date,
    end: date,
    lat: float,
    lon: float,
    timezone: str,
    location_name: str = '',
) -> List[Dict]:
    """Запускает gaurabda на [start, end] для (lat, lon, timezone).
    Возвращает плоский список событий.
    """
    GCTimeZone.LoadFile('')  # триггер ленивой загрузки таблицы часовых поясов

    loc = _build_location(location_name or 'loc', lat, lon, timezone)
    tz_offset = loc.m_fTimezone

    # Начинаем расчёт с полудня — gaurabda требует чтобы дата была не на стыке тити.
    beg = gaurabda.GCGregorianDate()
    beg.year = start.year
    beg.month = start.month
    beg.day = start.day
    beg.hour = 12
    beg.minute = 0
    beg.second = 0

    days_count = (end - start).days + 1
    cal = gaurabda.TCalendar()
    cal.CalculateCalendar(loc, beg, days_count)

    events: List[Dict] = []

    for i in range(days_count):
        day = cal.GetDay(i)
        # gaurabda хранит дату как объект с .year/.month/.day
        d_obj = day.date
        d = date(d_obj.year, d_obj.month, d_obj.day)

        # 1) Экадаши (пост в день экадаши)
        if day.ekadasi_vrata_name and day.nFastType:
            # ekadasi_vrata_name приходит уже как plain string ("Padmini Ekadasi")
            name_ru = translate(day.ekadasi_vrata_name)
            # nMhdType: 256 = EV_NULL (нет особенностей), 257 = EV_SUDDHA (чистая, нормативная).
            # Обе считаются обычными экадаши. Махадвадаши — это 258+ (Unmilani, Vyanjuli,
            # Trisprsa, Paksavardhini, Jaya, Jayanti, Papa-nasini, Vijaya).
            ek_type = 'mahadvadashi' if day.nMhdType >= 258 else 'regular'

            # fasting_start_at — восход в день экадаши
            sunrise_hh = _gctime_to_decimal(day.astrodata.sun.rise)
            fasting_start = _hour_decimal_to_iso(d, sunrise_hh, tz_offset)

            # fasting_end_at — начало паран-окна в день двадаши (следующий или после)
            # ищем ближайший день с ekadasi_parana
            paran_iso_start = None
            paran_iso_end = None
            start_reason = None
            end_reason = None
            for j in range(i + 1, min(i + 4, days_count)):
                pd = cal.GetDay(j)
                if pd.ekadasi_parana and pd.eparana_time1 > 0:
                    pd_obj = pd.date
                    pdate = date(pd_obj.year, pd_obj.month, pd_obj.day)
                    paran_iso_start = _hour_decimal_to_iso(pdate, pd.eparana_time1, tz_offset)
                    if pd.eparana_time2 > 0:
                        paran_iso_end = _hour_decimal_to_iso(pdate, pd.eparana_time2, tz_offset)
                    start_reason = _PARAN_REASONS.get(pd.eparana_type1)
                    end_reason = _PARAN_REASONS.get(pd.eparana_type2)
                    break

            paran_type_label = None
            if start_reason and end_reason and end_reason != 'none':
                paran_type_label = f'{start_reason}:{end_reason}'
            elif start_reason:
                paran_type_label = start_reason

            events.append({
                'event_date': d.isoformat(),
                'event_type': 'ekadashi',
                'event_name': name_ru,
                'ekadashi_type': ek_type,
                'fasting_start_at': fasting_start,
                'fasting_end_at': paran_iso_start,
                'paran_start_at': paran_iso_start,
                'paran_end_at': paran_iso_end,
                'paran_type': paran_type_label,
                'paran_start_reason': start_reason,
                'paran_end_reason': end_reason,
                'description': None,
                'calculated_by': CALCULATED_BY,
            })

        # 2) Праздники (явления / уходы / Ратха-ятра / Говардхана / ...)
        seen_names = set()
        for ev in (day.dayEvents or []):
            text = ev.get('text', '')
            disp = ev.get('disp', 0)
            # Фильтр: интересны только события класса CAL_FEST_0..6 (disp 22..28)
            # и масас. caturmasya (disp 13..15) — добавим как caturmasya_start.
            if not text:
                continue
            if text in seen_names:
                continue
            # Шум: gaurabda дублирует маркер поста как отдельное событие.
            # Эта информация уже зашита в строке экадаши — пропускаем.
            if text.startswith('(') and text.endswith(')'):
                continue
            tl_short = text.lower()
            if tl_short.startswith('fasting for ') or 'fasting subject' in tl_short:
                continue

            event_type = None
            if disp in (22, 23, 24, 25, 26, 27, 28):
                # классы фестивалей: appearance / disappearance / general
                tl = text.lower()
                # Важно: проверять disappearance ПЕРВЫМ — иначе "Disappearance"
                # ловится как "appearance" по подстроке.
                if 'disappearance' in tl:
                    event_type = 'disappearance'
                elif 'appearance' in tl or 'janmastami' in tl or ('navami' in tl and 'rama' in tl):
                    event_type = 'appearance'
                elif 'purnima' in tl:
                    event_type = 'purnima'
                elif 'amavasya' in tl or 'new moon' in tl:
                    event_type = 'amavasya'
                else:
                    event_type = 'other'
            elif disp in (13, 14, 15):
                # caturmasya systems (purnima / pratipat / ekadasi-based)
                tl = text.lower()
                if 'begins' in tl or 'first month' in tl:
                    event_type = 'caturmasya_start'
                elif 'ends' in tl or 'last month' in tl:
                    event_type = 'caturmasya_end'
                else:
                    event_type = 'caturmasya_start'
            else:
                continue

            seen_names.add(text)
            events.append({
                'event_date': d.isoformat(),
                'event_type': event_type,
                'event_name': translate(text),
                'ekadashi_type': None,
                'fasting_start_at': None,
                'fasting_end_at': None,
                'paran_start_at': None,
                'paran_end_at': None,
                'paran_type': None,
                'paran_start_reason': None,
                'paran_end_reason': None,
                'description': subtitle_for(text),
                'calculated_by': CALCULATED_BY,
            })

    return events


# =========================================================================
# Панчанга + астро на каждый день
# =========================================================================

def _gctime_to_seconds(t) -> Optional[int]:
    """gaurabda GCTime → секунды в локальном дне. None если не вычислено (-1:59:59)."""
    if t.hour < 0:
        return None
    return t.hour * 3600 + t.min * 60 + t.sec


def _time_to_iso(d: date, secs: Optional[int], tz_offset_hours: float) -> Optional[str]:
    """Секунды → ISO timestamptz. None пропускается."""
    if secs is None:
        return None
    return _hour_decimal_to_iso(d, secs / 3600.0, tz_offset_hours)


def calculate_panchanga(
    start: date,
    end: date,
    lat: float,
    lon: float,
    timezone: str,
    location_name: str = '',
) -> List[Dict]:
    """Возвращает per-day панчангу + солнце/луну для (lat, lon, timezone)."""
    GCTimeZone.LoadFile('')

    loc = _build_location(location_name or 'loc', lat, lon, timezone)
    tz_offset = loc.m_fTimezone
    earth = loc.GetEarthData()

    beg = gaurabda.GCGregorianDate()
    beg.year = start.year
    beg.month = start.month
    beg.day = start.day
    beg.hour = 12
    beg.minute = 0
    beg.second = 0

    days_count = (end - start).days + 1
    cal = gaurabda.TCalendar()
    cal.CalculateCalendar(loc, beg, days_count)

    rows: List[Dict] = []

    for i in range(days_count):
        day = cal.GetDay(i)
        d_obj = day.date
        d = date(d_obj.year, d_obj.month, d_obj.day)
        ad = day.astrodata

        # gaurabda nPaksa: 0=Кришна (как в дизайне), 1=Шукла.
        # tithi_in_paksha: 1..15 в пределах пакши.
        n_tithi = ad.nTithi  # 0..29
        if ad.nPaksa == 0:
            paksha_ru = 'Кришна'
            tithi_in_paksha = n_tithi + 1
        else:
            paksha_ru = 'Шукла'
            tithi_in_paksha = (n_tithi - 15) + 1
        if tithi_in_paksha < 1: tithi_in_paksha = 1
        if tithi_in_paksha > 15: tithi_in_paksha = 15

        # Россыпь имён через name_map
        try:
            tithi_en = GCStrings.GetTithiName(n_tithi)
        except Exception:
            tithi_en = ''
        tithi_ru = translate_tithi(tithi_en) or tithi_en or '—'

        try:
            masa_en = GCStrings.GetMasaName(ad.nMasa)
        except Exception:
            masa_en = ''
        masa_ru = translate_masa(masa_en) or masa_en or '—'

        try:
            naks_en = GCStrings.GetNaksatraName(ad.nNaksatra)
        except Exception:
            naks_en = ''
        naks_ru = translate_naksatra(naks_en) or naks_en or None

        # Солнце
        sun = ad.sun
        sunrise_secs = _gctime_to_seconds(sun.rise)
        sunset_secs  = _gctime_to_seconds(sun.set)
        noon_secs    = _gctime_to_seconds(sun.noon)
        length_secs  = _gctime_to_seconds(sun.length)

        # Брахма мухурта = 96 минут до восхода
        bm_secs = (sunrise_secs - 96 * 60) if sunrise_secs is not None else None

        sunrise_iso = _time_to_iso(d, sunrise_secs, tz_offset)
        sunset_iso  = _time_to_iso(d, sunset_secs, tz_offset)
        noon_iso    = _time_to_iso(d, noon_secs, tz_offset)
        bm_iso      = _time_to_iso(d, bm_secs, tz_offset) if bm_secs is not None else None

        day_length_min = round(length_secs / 60) if length_secs else None

        # Луна
        moonrise_t, moonset_t = GCMoonData.CalcMoonTimes(earth, day.date, float(day.hasDST))
        mr_secs = _gctime_to_seconds(moonrise_t)
        ms_secs = _gctime_to_seconds(moonset_t)
        moonrise_iso = _time_to_iso(d, mr_secs, tz_offset)
        moonset_iso  = _time_to_iso(d, ms_secs, tz_offset)

        # Возраст — день текущей пакши (как в дизайне: «12 д» в день Двадаши).
        # nTithiElapse в gaurabda — процент завершения тити (0..100).
        tithi_progress = float(ad.nTithiElapse or 0.0) / 100.0
        moon_age = round(tithi_in_paksha - 1 + tithi_progress, 1)

        # Освещённость — через msDistance.
        # В gaurabda msDistance = (moon_long - sun_long - 180) mod 360, т.е.
        # отсчитывается ОТ ПОЛНОЛУНИЯ: 0° = пурнима, 180° = амавасья.
        # Поэтому формула освещённости — (1 + cos)/2, а не (1 - cos)/2.
        ms_deg = float(ad.msDistance or 0.0) % 360.0
        moon_illum = round((1.0 + math.cos(math.radians(ms_deg))) / 2.0 * 100.0, 1)

        rows.append({
            'date': d.isoformat(),
            'tithi_index': tithi_in_paksha,
            'tithi_name': tithi_ru,
            'paksha': paksha_ru,
            'masa_name': masa_ru,
            'gaurabda_year': ad.nGaurabdaYear,
            'naksatra_name': naks_ru,
            'brahma_muhurta_at': bm_iso,
            'sunrise_at': sunrise_iso,
            'noon_at': noon_iso,
            'sunset_at': sunset_iso,
            'day_length_min': day_length_min,
            'moonrise_at': moonrise_iso,
            'moonset_at': moonset_iso,
            'moon_age_days': moon_age,
            'moon_illumination': moon_illum,
            'calculated_by': CALCULATED_BY,
        })

    return rows
