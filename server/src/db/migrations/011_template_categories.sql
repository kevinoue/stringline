-- Tag the built-in templates.
--
-- Without this the feature arrives empty: starting a closedown would mean
-- labelling twenty-two tasks by hand before the chart could show you anything,
-- which is the sort of setup cost that stops a feature being used at all.
--
-- Milestones are deliberately left untagged. A gate like "Dried in" or
-- "Property secured for the season" belongs to everyone and to no one, and
-- giving it a trade would put a coloured stripe on a diamond that represents
-- the whole job arriving somewhere.

-- ── Hotel seasonal closedown — by department ────────────────────────────────

UPDATE template_tasks t SET category_name = v.category
FROM (VALUES
  ('final_departures',     'Front office'),
  ('staff_offboard',       'Admin'),
  ('room_deep_clean',      'Housekeeping'),
  ('linen_strip',          'Housekeeping'),
  ('room_inventory',       'Housekeeping'),
  ('perishables',          'Food and beverage'),
  ('fb_inventory',         'Food and beverage'),
  ('kitchen_clean',        'Food and beverage'),
  ('walkins_down',         'Food and beverage'),
  ('pool_winterize',       'Maintenance'),
  ('plumbing_winterize',   'Maintenance'),
  ('water_shutoff',        'Maintenance'),
  ('hvac_setback',         'Maintenance'),
  ('fire_winter',          'Maintenance'),
  ('security_check',       'Maintenance'),
  ('exterior_furniture',   'Grounds'),
  ('irrigation_blowout',   'Grounds'),
  ('window_protection',    'Grounds'),
  ('snow_contract',        'Admin'),
  ('utility_readings',     'Admin'),
  ('final_walk',           'Admin')
) AS v(key, category)
WHERE t.key = v.key
  AND t.template_id IN (SELECT id FROM templates WHERE name = 'Hotel seasonal closedown');

-- ── Hotel seasonal reopening — the same departments, in reverse ─────────────

UPDATE template_tasks t SET category_name = v.category
FROM (VALUES
  ('utilities_on',          'Admin'),
  ('water_on',              'Maintenance'),
  ('plumbing_dewinterize',  'Maintenance'),
  ('legionella',            'Maintenance'),
  ('hvac_startup',          'Maintenance'),
  ('systems_test',          'Admin'),
  ('elevator_inspect',      'Maintenance'),
  ('fire_inspect',          'Maintenance'),
  ('pool_open',             'Maintenance'),
  ('pool_permit',           'Admin'),
  ('kitchen_startup',       'Food and beverage'),
  ('health_inspect',        'Food and beverage'),
  ('fb_restock',            'Food and beverage'),
  ('room_deep_clean',       'Housekeeping'),
  ('room_repairs',          'Maintenance'),
  ('linen_restock',         'Housekeeping'),
  ('grounds_open',          'Grounds'),
  ('exterior_furniture',    'Grounds'),
  ('staff_hire',            'Admin'),
  ('staff_train',           'Admin'),
  ('soft_open',             'Front office')
) AS v(key, category)
WHERE t.key = v.key
  AND t.template_id IN (SELECT id FROM templates WHERE name = 'Hotel seasonal reopening');

-- ── Single-family home build — by trade ─────────────────────────────────────
--
-- Nine trades rather than the fifteen a real job has. The palette holds ten,
-- and more than that on one chart is past what anyone can read — so framing
-- carries the envelope, and finishes are one trade rather than seven.

UPDATE template_tasks t SET category_name = v.category
FROM (VALUES
  ('permits',         'Permits and inspections'),
  ('found_inspect',   'Permits and inspections'),
  ('rough_inspect',   'Permits and inspections'),
  ('final_inspect',   'Permits and inspections'),
  ('survey',          'Sitework'),
  ('clear',           'Sitework'),
  ('backfill',        'Sitework'),
  ('driveway',        'Sitework'),
  ('landscaping',     'Sitework'),
  ('footings',        'Concrete'),
  ('framing',         'Framing'),
  ('windows',         'Framing'),
  ('siding',          'Framing'),
  ('roof',            'Roofing'),
  ('elec_rough',      'Electrical'),
  ('plumb_rough',     'Plumbing'),
  ('fixtures',        'Plumbing'),
  ('hvac_rough',      'HVAC'),
  ('insulation',      'Interior finishes'),
  ('drywall',         'Interior finishes'),
  ('interior_paint',  'Interior finishes'),
  ('cabinets',        'Interior finishes'),
  ('interior_trim',   'Interior finishes'),
  ('flooring',        'Interior finishes'),
  ('appliances',      'Interior finishes'),
  ('punch',           'Interior finishes')
) AS v(key, category)
WHERE t.key = v.key
  AND t.template_id IN (SELECT id FROM templates WHERE name = 'Single-family home build');

-- ── Guest room renovation — by trade ────────────────────────────────────────

UPDATE template_tasks t SET category_name = v.category
FROM (VALUES
  ('survey',    'Procurement'),
  ('order',     'Procurement'),
  ('ffe',       'Procurement'),
  ('strip',     'Demolition'),
  ('elec',      'Electrical'),
  ('av',        'Electrical'),
  ('plumb',     'Plumbing'),
  ('patch',     'Interior finishes'),
  ('tile',      'Interior finishes'),
  ('paint',     'Interior finishes'),
  ('flooring',  'Interior finishes'),
  ('trim',      'Interior finishes'),
  ('clean',     'Housekeeping'),
  ('inspect',   'Permits and inspections')
) AS v(key, category)
WHERE t.key = v.key
  AND t.template_id IN (SELECT id FROM templates WHERE name = 'Guest room renovation');
