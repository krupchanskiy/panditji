"""UPSERT событий в vaishnava_calendar через Supabase REST API (service_role)."""

import os
import sys
import requests
from typing import List, Dict


class SupabaseWriter:
    def __init__(self, url: str, service_role_key: str):
        self.url = url.rstrip('/')
        self.headers = {
            'apikey': service_role_key,
            'Authorization': f'Bearer {service_role_key}',
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal',
        }

    def get_user_locations(self, user_id: str) -> List[Dict]:
        r = requests.get(
            f'{self.url}/rest/v1/locations',
            params={'user_id': f'eq.{user_id}', 'select': 'id,key,name,lat,lon,timezone'},
            headers={'apikey': self.headers['apikey'], 'Authorization': self.headers['Authorization']},
            timeout=30,
        )
        r.raise_for_status()
        return r.json()

    def upsert_events(self, user_id: str, location_id: str, events: List[Dict], chunk_size: int = 200) -> int:
        if not events:
            return 0

        # Подмешиваем user_id и location_id, ставим conflict-target.
        rows = []
        for e in events:
            row = dict(e)
            row['user_id'] = user_id
            row['location_id'] = location_id
            rows.append(row)

        total = 0
        for i in range(0, len(rows), chunk_size):
            chunk = rows[i:i + chunk_size]
            r = requests.post(
                f'{self.url}/rest/v1/vaishnava_calendar',
                params={'on_conflict': 'user_id,location_id,event_date,event_name'},
                headers=self.headers,
                json=chunk,
                timeout=60,
            )
            if r.status_code >= 400:
                # печатаем ответ для диагностики
                sys.stderr.write(f'UPSERT failed [{r.status_code}]: {r.text[:1000]}\n')
                r.raise_for_status()
            total += len(chunk)
        return total
