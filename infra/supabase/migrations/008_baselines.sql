-- 008_baselines.sql
-- Универсальные «личные нормы» по любым метрикам всех доменов.
-- Заменяет отдельные таблицы biometric_baseline/meditation_baseline (architecture 5.2).
-- Rollback: DROP TABLE baselines;

CREATE TABLE baselines (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    domain       text NOT NULL,
    metric       text NOT NULL,

    location_id  uuid REFERENCES locations(id),
    context      jsonb,

    mean         numeric(12,4) NOT NULL,
    stddev       numeric(12,4) NOT NULL,
    p10          numeric(12,4),
    p50          numeric(12,4),
    p90          numeric(12,4),
    sample_size  int NOT NULL,

    valid_from   date NOT NULL,
    valid_to     date,

    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (user_id, domain, metric, location_id, valid_from)
);

COMMENT ON TABLE  baselines             IS 'Личные нормы по метрикам всех доменов. valid_to IS NULL = действующая версия.';
COMMENT ON COLUMN baselines.domain      IS 'biometric | meditation | blood_test | check_in';
COMMENT ON COLUMN baselines.metric      IS 'hrv_rmssd | mind_wandering_pct | ldl | sleep_efficiency и т.д.';
COMMENT ON COLUMN baselines.location_id IS 'Если задана — норма специфична для локации (HRV в Индии vs Москве отличается).';
COMMENT ON COLUMN baselines.context     IS 'Доп. условия среза нормы: {"after_flight_days":">=7"}, {"day_of_week":1} и т.п.';

ALTER TABLE baselines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_owns_data" ON baselines
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE INDEX idx_baselines_user_domain ON baselines(user_id, domain, metric) WHERE valid_to IS NULL;
