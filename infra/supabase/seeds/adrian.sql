-- adrian.sql
-- Сидинг данных Адриана: auth.users + identity + 2 локации + профиль + 3 утренних дела.
-- Применять один раз после миграций 001-005. Идемпотентность не гарантирована — повторный запуск упадёт на UNIQUE.

DO $$
DECLARE
    v_user_id   uuid := gen_random_uuid();
    v_moscow_id uuid;
    v_govard_id uuid;
BEGIN
    INSERT INTO auth.users (
        instance_id, id, aud, role, email,
        email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at,
        confirmation_token, email_change, email_change_token_new, recovery_token,
        is_super_admin
    ) VALUES (
        '00000000-0000-0000-0000-000000000000',
        v_user_id,
        'authenticated', 'authenticated',
        'adrian@adrian.ru',
        now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{}'::jsonb,
        now(), now(),
        '', '', '', '',
        false
    );

    INSERT INTO auth.identities (
        id, user_id, provider_id, provider, identity_data,
        last_sign_in_at, created_at, updated_at
    ) VALUES (
        gen_random_uuid(),
        v_user_id,
        v_user_id::text,
        'email',
        jsonb_build_object(
            'sub', v_user_id::text,
            'email', 'adrian@adrian.ru',
            'email_verified', true,
            'phone_verified', false
        ),
        now(), now(), now()
    );

    INSERT INTO locations (user_id, key, name, country, lat, lon, timezone, is_primary)
    VALUES (v_user_id, 'moscow',    'Москва',    'Россия', 55.755826, 37.617300, 'Europe/Moscow',  false)
    RETURNING id INTO v_moscow_id;

    INSERT INTO locations (user_id, key, name, country, lat, lon, timezone, is_primary)
    VALUES (v_user_id, 'govardhan', 'Говардхан', 'Индия',  27.484200, 77.457100, 'Asia/Kolkata',   true)
    RETURNING id INTO v_govard_id;

    INSERT INTO user_profile (
        id, spiritual_name, full_name, short_name,
        birth_date, birth_time, birth_tz, birth_lat, birth_lon, birth_place,
        height_cm, primary_lang, current_location_id
    ) VALUES (
        v_user_id,
        'Ачинтья Кришна джи',
        'Адриан Крупчанский',
        'Ачинтья джи',
        '1977-12-07', '06:15:00', 'Europe/Moscow', 55.755826, 37.617300, 'Москва, СССР',
        175, 'ru',
        v_moscow_id
    );

    INSERT INTO daily_todos (user_id, todo_key, emoji, emoji_variant, label, sort_order)
    VALUES
        (v_user_id, 'water', '💧', 'water', 'Выпить стакан воды',        10),
        (v_user_id, 'scale', '⚖️', 'scale', 'Взвеситься',                20),
        (v_user_id, 'japa',  '🔔', 'bell',  'Сразу пойти читать джапу',  30);

    RAISE NOTICE 'Created user_id = %', v_user_id;
END $$;
