-- 019_meditation_baseline_avg_beta.sql
-- Добавляем avg_beta — session-level средняя Beta для baselineValue третьей метрики
-- сравнения (beta-как-фон-беспокойства) в SessionReport. По дизайну compare имеет
-- три метрики: deepening / stability / beta — все per-circle, но с скалярным
-- заголовком. avg_deepening и avg_stability уже есть, добавляем парный avg_beta.
--
-- Rollback: ALTER TABLE meditation_baseline DROP COLUMN avg_beta;

ALTER TABLE meditation_baseline
    ADD COLUMN avg_beta numeric(5,2);

COMMENT ON COLUMN meditation_baseline.avg_beta IS
    'Среднее beta_median_rel по сессиям в фильтре (period × calm_only). Для baselineValue третьей карточки compare (beta-фон).';
