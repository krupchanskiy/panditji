-- 009_whoop.sql
-- Whoop: сон, активности, дневной recovery.
-- whoop_id уникален в системе Whoop, обеспечивает идемпотентность fetcher-функций.
-- Rollback: DROP TABLE whoop_recovery; DROP TABLE whoop_workouts; DROP TABLE whoop_sleeps;

CREATE TABLE whoop_sleeps (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    whoop_id        text NOT NULL UNIQUE,

    start_at        timestamptz NOT NULL,
    end_at          timestamptz NOT NULL,
    timezone_offset text NOT NULL,

    duration_seconds      int NOT NULL,
    sleep_efficiency      numeric(5,2),
    sleep_performance     numeric(5,2),

    light_sleep_seconds   int,
    deep_sleep_seconds    int,
    rem_sleep_seconds     int,
    awake_seconds         int,

    disturbance_count     int,

    hrv_rmssd_ms          numeric(6,2),
    resting_heart_rate    int,
    respiratory_rate      numeric(4,1),
    spo2_percentage       numeric(5,2),
    skin_temp_celsius     numeric(4,2),

    recovery_score        int,

    raw_response          jsonb NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  whoop_sleeps                IS 'Сон по данным Whoop API. Одна запись = одна ночь.';
COMMENT ON COLUMN whoop_sleeps.whoop_id       IS 'ID в системе Whoop. Идемпотентность при повторных fetcher-запусках.';
COMMENT ON COLUMN whoop_sleeps.hrv_rmssd_ms   IS 'HRV RMSSD в мс — главный индикатор готовности нервной системы.';
COMMENT ON COLUMN whoop_sleeps.raw_response   IS 'Полный JSON-ответ Whoop API на случай переразбора при изменении схемы.';

ALTER TABLE whoop_sleeps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_data" ON whoop_sleeps FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE TRIGGER trigger_update_updated_at BEFORE UPDATE ON whoop_sleeps FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE INDEX idx_whoop_sleeps_user_date ON whoop_sleeps(user_id, start_at DESC);


CREATE TABLE whoop_workouts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    whoop_id        text NOT NULL UNIQUE,

    start_at        timestamptz NOT NULL,
    end_at          timestamptz NOT NULL,
    duration_seconds int NOT NULL,

    sport           text,
    strain          numeric(5,2),
    avg_heart_rate  int,
    max_heart_rate  int,
    kilojoules      numeric(7,2),

    raw_response    jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  whoop_workouts        IS 'Активности по Whoop. Большинство — автоматически детектированные.';
COMMENT ON COLUMN whoop_workouts.strain IS 'Whoop Strain 0-21 — нагрузка организма за активность.';

ALTER TABLE whoop_workouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_data" ON whoop_workouts FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE INDEX idx_whoop_workouts_user_date ON whoop_workouts(user_id, start_at DESC);


CREATE TABLE whoop_recovery (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    whoop_id        text NOT NULL UNIQUE,

    date            date NOT NULL,
    sleep_id        uuid REFERENCES whoop_sleeps(id),

    recovery_score      int NOT NULL,
    hrv_rmssd_ms        numeric(6,2),
    resting_heart_rate  int,
    respiratory_rate    numeric(4,1),
    spo2_percentage     numeric(5,2),
    skin_temp_celsius   numeric(4,2),

    week_avg_hrv        numeric(6,2),

    raw_response        jsonb NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  whoop_recovery                IS 'Дневной Recovery от Whoop. Главный «индикатор дня».';
COMMENT ON COLUMN whoop_recovery.recovery_score IS 'Whoop Recovery Score 0-100 — % готовности дня.';
COMMENT ON COLUMN whoop_recovery.week_avg_hrv   IS 'Кешируем средний HRV за неделю для быстрых сравнений в утреннем экране.';

ALTER TABLE whoop_recovery ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_data" ON whoop_recovery FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE UNIQUE INDEX idx_whoop_recovery_user_date ON whoop_recovery(user_id, date);
