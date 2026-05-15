-- 017_meditation.sql
-- Домен медитации (джапа): сессии Muse, агрегаты по кругам, baseline, pending-диалог Telegram.
-- Источник данных: Mind Monitor CSV → telegram-webhook → parse-meditation-csv Edge Function.
-- Локации — общая таблица locations (migration 002). Отдельной meditation_locations не делаем.
-- Telegram chat_id — общий user_profile.telegram_chat_id (migration 012). В meditation_pending_session не дублируется.
--
-- Rollback:
--   DROP TABLE meditation_pending_session;
--   DROP TABLE meditation_baseline;
--   DROP TABLE meditation_circles;
--   DROP TABLE meditation_sessions;


-- =============================================================================
-- meditation_sessions
-- =============================================================================
-- Одна строка = одна сессия джапы. Заполняется в два этапа:
--   1. parse-meditation-csv — сессионные агрегаты, timeline, качество сигнала.
--   2. compute-meditation-circles (после подтверждения circles в боте) — разбивка,
--      deepening, longest_calm, теги, интерпретации.
-- Поля группы 2 до подтверждения остаются NULL.

CREATE TABLE meditation_sessions (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    source                text NOT NULL DEFAULT 'mind_monitor',

    -- Время и место
    started_at            timestamptz NOT NULL,
    ended_at              timestamptz NOT NULL,
    duration_sec          int NOT NULL,
    location_id           uuid REFERENCES locations(id) ON DELETE SET NULL,

    -- Тип сессии и учёт в статистике
    session_kind          text NOT NULL DEFAULT 'regular'
                          CHECK (session_kind IN ('regular', 'preview')),
    excluded_from_stats   boolean NOT NULL DEFAULT false,
    excluded_reason       text CHECK (excluded_reason IN ('preview', 'manual')),
    excluded_at           timestamptz,

    -- Структура (заполняется после диалога в боте)
    circles               int CHECK (circles IS NULL OR circles BETWEEN 1 AND 200),
    pace_min_per_circle   numeric(4,2),

    -- Качество сигнала
    signal_quality_pct    numeric(5,2) NOT NULL,
    artifacts_level       text NOT NULL
                          CHECK (artifacts_level IN ('низкий', 'умеренный', 'высокий')),
    electrodes_status     jsonb NOT NULL,
    headband_on_pct       numeric(5,2) NOT NULL,

    -- Артефакт повязки (резкая ступенька в данных, HSI этого не ловит)
    signal_shift_at_sec   int,
    signal_shift_severity text CHECK (signal_shift_severity IN ('medium', 'high')),

    -- Достоверность производных метрик. NULL = ещё не считали (нет circles).
    deepening_reliable    boolean,

    -- Контекст от пользователя (бот)
    distracted            text CHECK (distracted IN ('никто', 'немного', 'сильно')),
    self_rating           int CHECK (self_rating BETWEEN 1 AND 5),
    user_note             text,

    -- Кэш Whoop-контекста на момент сессии. Заполняется отложенным job-ом.
    whoop_sleep_hours     numeric(4,2),
    whoop_recovery_pct    int CHECK (whoop_recovery_pct IS NULL OR whoop_recovery_pct BETWEEN 0 AND 100),
    whoop_enriched_at     timestamptz,

    -- Сессионные медианы относительных мощностей, %
    alpha_median_rel      numeric(5,2) NOT NULL,
    theta_median_rel      numeric(5,2) NOT NULL,
    beta_median_rel       numeric(5,2) NOT NULL,
    gamma_median_rel      numeric(5,2) NOT NULL,
    delta_median_rel      numeric(5,2) NOT NULL,
    ab_index_median       numeric(5,2) NOT NULL,
    tb_index_median       numeric(5,2) NOT NULL,

    -- Theta/Alpha/Delta по третям (для авто-тегов сонливости и deepening_pct)
    alpha_first_third     numeric(5,2),
    alpha_last_third      numeric(5,2),
    theta_first_third     numeric(5,2),
    theta_last_third      numeric(5,2),
    delta_first_third     numeric(5,2),
    delta_last_third      numeric(5,2),

    -- Пульс по третям (для отличия дрёмы от углубления)
    hr_first_third        numeric(5,1),
    hr_last_third         numeric(5,1),
    hr_median             numeric(5,1),

    -- Производные метрики (заполняются после circles)
    deepening_pct         numeric(6,2),
    longest_calm_sec      int,
    longest_calm_at_sec   int,
    calm_periods_count    int,

    -- Категория длительности vs персональная медиана за 30 дней
    duration_category     text CHECK (duration_category IN ('standard', 'short', 'long')),
    duration_vs_median_pct numeric(5,1),

    -- Timeline 30-секундных окон (для пересчёта calm и графиков)
    timeline_30s          jsonb,

    -- Теги: авто-присвоенные и пользовательские
    auto_tags             text[] NOT NULL DEFAULT '{}',
    user_tags             text[] NOT NULL DEFAULT '{}',

    -- Сгенерированные интерпретации: { main, calm, phases }
    interpretations       jsonb,
    interpretation_version text NOT NULL DEFAULT 'v1',

    -- Хранение исходного CSV для re-parse при апгрейде парсера
    csv_storage_path      text NOT NULL,
    csv_size_bytes        int NOT NULL,
    parser_version        text NOT NULL DEFAULT 'v1',

    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),

    -- Целостность учёта: если excluded_from_stats=true, должна быть причина и timestamp
    CONSTRAINT excluded_consistency CHECK (
        (excluded_from_stats = false AND excluded_reason IS NULL AND excluded_at IS NULL)
        OR
        (excluded_from_stats = true  AND excluded_reason IS NOT NULL AND excluded_at IS NOT NULL)
    )
);

COMMENT ON TABLE  meditation_sessions IS
    'Сессия джапы по данным Muse (Mind Monitor CSV). Сессионные агрегаты + timeline 30s + кэш Whoop-контекста.';

COMMENT ON COLUMN meditation_sessions.source IS
    'Источник данных. Сейчас всегда mind_monitor. Поле есть на случай других интеграций (Muse Direct, например).';
COMMENT ON COLUMN meditation_sessions.session_kind IS
    'regular = обычная джапа, учитывается в статистике. preview = "только посмотреть", не влияет на baseline и тренды.';
COMMENT ON COLUMN meditation_sessions.excluded_from_stats IS
    'true для preview ИЛИ если пользователь вручную исключил сессию из статистики. Базовое условие baseline и корреляций.';
COMMENT ON COLUMN meditation_sessions.excluded_reason IS
    'preview = автоматически при kind=preview. manual = пользователь нажал "исключить" в PWA.';
COMMENT ON COLUMN meditation_sessions.circles IS
    'Число прочитанных кругов. NULL = пользователь ещё не подтвердил в боте. До подтверждения круги, deepening, longest_calm не считаются.';
COMMENT ON COLUMN meditation_sessions.signal_quality_pct IS
    '% строк CSV, где HSI<=2 на всех 4 электродах одновременно (good signal).';
COMMENT ON COLUMN meditation_sessions.electrodes_status IS
    'jsonb: { TP9: "ok"|"warn"|"bad", AF7: ..., AF8: ..., TP10: ... }. Покругольная доля good на каждом электроде.';
COMMENT ON COLUMN meditation_sessions.headband_on_pct IS
    '% строк CSV с HeadBandOn=1. Норма >=95%. При <50% сессия не сохраняется (см. парсер).';
COMMENT ON COLUMN meditation_sessions.signal_shift_at_sec IS
    'Секунда обнаруженной резкой смены сигнала (Theta ×2.5 или Alpha ×0.4 за 30с, удержание ≥5 мин). NULL = не было.';
COMMENT ON COLUMN meditation_sessions.signal_shift_severity IS
    'medium = только один маркер сработал. high = и Theta-jump, и Alpha-drop. high исключает сессию из calm-baseline.';
COMMENT ON COLUMN meditation_sessions.deepening_reliable IS
    'false если theta_first_third < 1% (защита от деления на близкое к нулю) ИЛИ deepening_pct > 200% ИЛИ есть signal_shift. NULL = circles ещё не подтверждён.';
COMMENT ON COLUMN meditation_sessions.whoop_enriched_at IS
    'Когда отрабатывал enrich-meditation-with-whoop. NULL = ещё не пробовали. Заполнено даже если данных не нашли.';
COMMENT ON COLUMN meditation_sessions.ab_index_median IS
    'Стабильность сессии: медиана Alpha/Beta. Чем выше — тем меньше "болтающего ума".';
COMMENT ON COLUMN meditation_sessions.deepening_pct IS
    'Углубление: (theta_last_third - theta_first_third) / theta_first_third × 100. NULL если deepening_reliable=false.';
COMMENT ON COLUMN meditation_sessions.longest_calm_sec IS
    'Самый длинный непрерывный отрезок calm-окон (ab_index > P75 по сессии). Из timeline_30s.';
COMMENT ON COLUMN meditation_sessions.calm_periods_count IS
    'Сколько отдельных calm-отрезков длиной >=60 сек было в сессии.';
COMMENT ON COLUMN meditation_sessions.duration_category IS
    'standard = ±25% от медианы за 30 дней. short / long иначе. NULL = в базе <5 сессий для расчёта медианы.';
COMMENT ON COLUMN meditation_sessions.timeline_30s IS
    'Массив 30-сек окон: [{ t, alpha, theta, beta, gamma, delta, ab, tb, signal_ok }]. Для пересчёта calm и графиков.';
COMMENT ON COLUMN meditation_sessions.auto_tags IS
    'Авто-теги по правилам в коде (см. computeAutoTags). Точные строки на русском, используются в фильтрах и шаблонах.';
COMMENT ON COLUMN meditation_sessions.interpretations IS
    'Сгенерированные шаблонами тексты: { main: string, calm: string, phases: [{label, range, note}] }.';
COMMENT ON COLUMN meditation_sessions.interpretation_version IS
    'Версия шаблонов интерпретации. При обновлении шаблонов get-session-report лениво пересчитывает.';
COMMENT ON COLUMN meditation_sessions.csv_storage_path IS
    'Путь к gzip-CSV в Storage bucket meditation-csv. Хранится для re-parse при апгрейде парсера.';
COMMENT ON COLUMN meditation_sessions.parser_version IS
    'Версия парсера. При смене — reparse-all-sessions перепарсит и обновит метрики.';

ALTER TABLE meditation_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_data" ON meditation_sessions
    FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TRIGGER trigger_update_updated_at
    BEFORE UPDATE ON meditation_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_meditation_sessions_user_started
    ON meditation_sessions(user_id, started_at DESC);
CREATE INDEX idx_meditation_sessions_whoop_pending
    ON meditation_sessions(user_id) WHERE whoop_enriched_at IS NULL;
CREATE INDEX idx_meditation_sessions_stats
    ON meditation_sessions(user_id, started_at DESC) WHERE excluded_from_stats = false;


-- =============================================================================
-- meditation_circles
-- =============================================================================
-- Агрегаты по каждому кругу. Заполняется только после подтверждения circles в боте.
-- До этого момента — нет строк для сессии.

CREATE TABLE meditation_circles (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   uuid NOT NULL REFERENCES meditation_sessions(id) ON DELETE CASCADE,

    circle_num   int NOT NULL CHECK (circle_num >= 1),
    t_start_sec  int NOT NULL,
    t_end_sec    int NOT NULL,

    -- Медианы относительных мощностей внутри круга, только good signal
    alpha_rel    numeric(5,2) NOT NULL,
    theta_rel    numeric(5,2) NOT NULL,
    beta_rel     numeric(5,2) NOT NULL,
    gamma_rel    numeric(5,2) NOT NULL,
    delta_rel    numeric(5,2) NOT NULL,

    ab_index     numeric(5,2) NOT NULL,
    tb_index     numeric(5,2) NOT NULL,

    signal_pct   numeric(5,2) NOT NULL,

    UNIQUE(session_id, circle_num)
);

COMMENT ON TABLE  meditation_circles IS
    'Агрегаты по каждому кругу джапы. Считается из timeline_30s после подтверждения circles в боте.';
COMMENT ON COLUMN meditation_circles.alpha_rel IS
    'Относительная мощность Alpha-диапазона в этом круге, % от суммы (alpha+theta+beta+gamma+delta).';
COMMENT ON COLUMN meditation_circles.ab_index IS
    'Alpha/Beta индекс — мера стабильности концентрации внутри круга.';
COMMENT ON COLUMN meditation_circles.signal_pct IS
    '% времени круга, где сигнал был good (HSI<=2). Низкое значение = метрики этого круга приблизительные.';

ALTER TABLE meditation_circles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_data" ON meditation_circles
    FOR ALL USING (
        EXISTS (SELECT 1 FROM meditation_sessions s
                WHERE s.id = meditation_circles.session_id AND s.user_id = auth.uid())
    )
    WITH CHECK (
        EXISTS (SELECT 1 FROM meditation_sessions s
                WHERE s.id = meditation_circles.session_id AND s.user_id = auth.uid())
    );

CREATE INDEX idx_meditation_circles_session
    ON meditation_circles(session_id, circle_num);


-- =============================================================================
-- meditation_baseline
-- =============================================================================
-- Кэшированные средние по сессиям пользователя за период. Используется для сравнений.
-- Пересчитывается лениво в get-session-report при стейлности или явно в toggle-session-exclusion.
-- Cron не используется (см. обсуждение Q3 — пересчёт on-demand).

CREATE TABLE meditation_baseline (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    period                   text NOT NULL CHECK (period IN ('w', 'm', 'q', 'all')),
    calm_only                boolean NOT NULL,

    session_count            int NOT NULL,

    -- Средние по сессии для трёх главных метрик сравнения
    avg_deepening            numeric(5,2),
    avg_stability            numeric(5,2),
    avg_longest_calm_sec     int,
    avg_calm_periods_count   numeric(4,1),

    -- Средние по нормализованной позиции в сессии (массивы длины 16).
    -- Индекс i = позиция [i/16, (i+1)/16] от начала сессии.
    -- Так baseline сравним между сессиями с разным числом кругов.
    avg_alpha_normalized     numeric(5,2)[],
    avg_theta_normalized     numeric(5,2)[],
    avg_beta_normalized      numeric(5,2)[],
    avg_ab_normalized        numeric(5,2)[],

    computed_at              timestamptz NOT NULL DEFAULT now(),

    UNIQUE(user_id, period, calm_only)
);

COMMENT ON TABLE  meditation_baseline IS
    'Кэш средних по сессиям за период. Один user × period × calm_only = одна строка.';
COMMENT ON COLUMN meditation_baseline.period IS
    'w = 7 дней, m = 30 дней, q = 90 дней, all = всё время.';
COMMENT ON COLUMN meditation_baseline.calm_only IS
    'true = только сессии с signal_quality>=80, без артефактов повязки. НЕ зависит от self_rating/distracted (иначе circular reasoning).';
COMMENT ON COLUMN meditation_baseline.avg_alpha_normalized IS
    'Массив длины 16. Средняя Alpha по нормализованной позиции [i/16, (i+1)/16] от начала сессии.';
COMMENT ON COLUMN meditation_baseline.computed_at IS
    'Когда последний раз пересчитан. Если устарел (>24ч) или есть новая сессия — get-session-report пересчитает.';

ALTER TABLE meditation_baseline ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_data" ON meditation_baseline
    FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());


-- =============================================================================
-- meditation_pending_session
-- =============================================================================
-- Состояние диалога Telegram-бота для джапы. Один pending на пользователя.
-- telegram_chat_id берётся из user_profile (migration 012), здесь не дублируется.

CREATE TABLE meditation_pending_session (
    user_id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

    session_id         uuid NOT NULL REFERENCES meditation_sessions(id) ON DELETE CASCADE,
    step               text NOT NULL
                       CHECK (step IN ('kind', 'circles', 'location', 'location_custom', 'distracted', 'rating')),

    started_at         timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,

    updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  meditation_pending_session IS
    'Активный диалог сбора контекста после загрузки CSV. Просроченные (expires_at < now()) удаляются при новом CSV без вопроса.';
COMMENT ON COLUMN meditation_pending_session.step IS
    'kind → circles → location → (location_custom) → distracted → rating. После rating запись удаляется.';
COMMENT ON COLUMN meditation_pending_session.expires_at IS
    'started_at + 48 часов по умолчанию. При новом CSV свежий pending — спрашиваем; просроченный — удаляем тихо.';

ALTER TABLE meditation_pending_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_data" ON meditation_pending_session
    FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TRIGGER trigger_update_updated_at
    BEFORE UPDATE ON meditation_pending_session
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
