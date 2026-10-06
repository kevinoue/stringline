-- Built-in templates (company_id NULL = available to everyone).
--
-- Durations are working days and are starting points, not gospel: a template's
-- job is to stop someone facing an empty screen, not to tell them how long
-- their own crew takes.
--
-- The two hotel templates are the ones nothing else on the market ships.
-- Seasonal properties close and reopen every year and rebuild the same plan
-- from memory each time, which is exactly the work a template removes.

-- ── Hotel seasonal closedown ────────────────────────────────────────────────

WITH t AS (
  INSERT INTO templates (company_id, name, description, category)
  VALUES (NULL, 'Hotel seasonal closedown',
    'Closing a seasonal property for the off-season: guest rooms, kitchen, winterisation, grounds and handover to caretaking.',
    'hospitality')
  RETURNING id
), ins AS (
  INSERT INTO template_tasks (template_id, key, name, duration_days, phase_name, sort_order, visibility)
  SELECT t.id, v.key, v.name, v.dur, v.phase, v.ord, v.vis FROM t, (VALUES
    ('final_departures','Final guest departures',1,'Wind-down',10,'client'),
    ('staff_offboard','Staff offboarding and final payroll',2,'Wind-down',20,'internal'),
    ('room_deep_clean','Deep clean all guest rooms',5,'Rooms',30,'internal'),
    ('linen_strip','Strip, launder and store linens',3,'Rooms',40,'internal'),
    ('room_inventory','Guest room inventory and damage log',2,'Rooms',50,'internal'),
    ('perishables','Dispose or transfer perishables',1,'Food and beverage',60,'internal'),
    ('fb_inventory','F&B and bar inventory count',2,'Food and beverage',70,'internal'),
    ('kitchen_clean','Kitchen deep clean and degrease',3,'Food and beverage',80,'internal'),
    ('walkins_down','Empty, defrost and shut down walk-ins',2,'Food and beverage',90,'internal'),
    ('pool_winterize','Drain and winterise pool and spa',2,'Building systems',100,'internal'),
    ('plumbing_winterize','Winterise plumbing — drain lines, antifreeze traps',4,'Building systems',110,'internal'),
    ('water_shutoff','Shut off and drain domestic water',1,'Building systems',120,'internal'),
    ('hvac_setback','Set HVAC to winter minimum and verify freeze protection',1,'Building systems',130,'internal'),
    ('fire_winter','Fire system to winter mode, confirm monitoring',1,'Building systems',140,'internal'),
    ('exterior_furniture','Store exterior furniture and umbrellas',2,'Grounds',150,'internal'),
    ('irrigation_blowout','Irrigation blowout and grounds closedown',2,'Grounds',160,'internal'),
    ('window_protection','Board or shutter exposed windows',2,'Grounds',170,'internal'),
    ('snow_contract','Confirm snow removal and caretaking contract',1,'Handover',180,'internal'),
    ('utility_readings','Final utility readings, switch to seasonal accounts',1,'Handover',190,'internal'),
    ('security_check','Security system and camera check',1,'Handover',200,'internal'),
    ('final_walk','Property walk-through and photo record',1,'Handover',210,'internal'),
    ('closed','Property secured for the season',0,'Handover',220,'client')
  ) AS v(key,name,dur,phase,ord,vis)
  RETURNING template_id
)
INSERT INTO template_dependencies (template_id, predecessor_key, successor_key, type, lag_days)
SELECT t.id, v.p, v.s, v.ty, v.lag FROM t, (VALUES
  ('final_departures','room_deep_clean','FS',0),
  ('final_departures','perishables','FS',0),
  ('final_departures','staff_offboard','FS',0),
  ('room_deep_clean','linen_strip','FS',0),
  ('room_deep_clean','room_inventory','FS',0),
  ('perishables','kitchen_clean','FS',0),
  ('perishables','fb_inventory','FS',0),
  ('kitchen_clean','walkins_down','FS',0),
  ('room_inventory','plumbing_winterize','FS',0),
  ('walkins_down','plumbing_winterize','FS',0),
  ('final_departures','pool_winterize','FS',0),
  ('plumbing_winterize','water_shutoff','FS',0),
  ('water_shutoff','hvac_setback','FS',0),
  ('hvac_setback','fire_winter','FS',0),
  ('final_departures','exterior_furniture','FS',0),
  ('exterior_furniture','irrigation_blowout','FS',0),
  ('irrigation_blowout','window_protection','FS',0),
  ('fire_winter','security_check','FS',0),
  ('window_protection','security_check','FS',0),
  ('security_check','utility_readings','FS',0),
  ('security_check','snow_contract','FS',0),
  ('utility_readings','final_walk','FS',0),
  ('snow_contract','final_walk','FS',0),
  ('linen_strip','final_walk','FS',0),
  ('fb_inventory','final_walk','FS',0),
  ('pool_winterize','final_walk','FS',0),
  ('staff_offboard','final_walk','FS',0),
  ('final_walk','closed','FS',0)
) AS v(p,s,ty,lag);

-- ── Hotel seasonal reopening ────────────────────────────────────────────────

WITH t AS (
  INSERT INTO templates (company_id, name, description, category)
  VALUES (NULL, 'Hotel seasonal reopening',
    'Bringing a seasonal property back online: de-winterisation, inspections and certifications, staffing, and a soft open before guests arrive.',
    'hospitality')
  RETURNING id
), ins AS (
  INSERT INTO template_tasks (template_id, key, name, duration_days, phase_name, sort_order, visibility)
  SELECT t.id, v.key, v.name, v.dur, v.phase, v.ord, v.vis FROM t, (VALUES
    ('utilities_on','Utilities on and meter readings',1,'Systems',10,'internal'),
    ('water_on','Restore and pressure-test domestic water',2,'Systems',20,'internal'),
    ('plumbing_dewinterize','De-winterise plumbing and flush lines',3,'Systems',30,'internal'),
    ('legionella','Water quality testing and legionella flush',3,'Systems',40,'internal'),
    ('hvac_startup','HVAC startup, filter change and commissioning',3,'Systems',50,'internal'),
    ('systems_test','PMS, POS and Wi-Fi systems test',2,'Systems',60,'internal'),
    ('elevator_inspect','Elevator inspection and certification',1,'Inspections',70,'internal'),
    ('fire_inspect','Fire and life-safety inspection',2,'Inspections',80,'internal'),
    ('pool_open','Pool and spa open, chemical balance',3,'Inspections',90,'internal'),
    ('pool_permit','Pool health inspection and permit',1,'Inspections',100,'internal'),
    ('kitchen_startup','Kitchen startup, walk-ins to temperature',2,'Food and beverage',110,'internal'),
    ('health_inspect','Health department inspection',1,'Inspections',120,'internal'),
    ('fb_restock','F&B restock and bar setup',3,'Food and beverage',130,'internal'),
    ('room_deep_clean','Deep clean all guest rooms',6,'Rooms',140,'internal'),
    ('room_repairs','Guest room repairs and touch-ups',5,'Rooms',150,'internal'),
    ('linen_restock','Linen and amenity restock',2,'Rooms',160,'internal'),
    ('grounds_open','Grounds, landscaping and irrigation startup',4,'Grounds',170,'internal'),
    ('exterior_furniture','Exterior furniture out and set',2,'Grounds',180,'internal'),
    ('staff_hire','Seasonal staff hiring',10,'People',190,'internal'),
    ('staff_train','Staff training and orientation',4,'People',200,'internal'),
    ('soft_open','Soft opening — test reservations',3,'Opening',210,'client'),
    ('open','Open to guests',0,'Opening',220,'client')
  ) AS v(key,name,dur,phase,ord,vis)
  RETURNING template_id
)
INSERT INTO template_dependencies (template_id, predecessor_key, successor_key, type, lag_days)
SELECT t.id, v.p, v.s, v.ty, v.lag FROM t, (VALUES
  ('utilities_on','water_on','FS',0),
  ('water_on','plumbing_dewinterize','FS',0),
  ('plumbing_dewinterize','legionella','FS',0),
  ('utilities_on','hvac_startup','FS',0),
  ('utilities_on','systems_test','FS',0),
  ('hvac_startup','elevator_inspect','FS',0),
  ('legionella','fire_inspect','FS',0),
  ('plumbing_dewinterize','pool_open','FS',0),
  ('pool_open','pool_permit','FS',0),
  ('legionella','kitchen_startup','FS',0),
  ('kitchen_startup','health_inspect','FS',0),
  ('health_inspect','fb_restock','FS',0),
  ('legionella','room_repairs','FS',0),
  ('room_repairs','room_deep_clean','FS',0),
  ('room_deep_clean','linen_restock','FS',0),
  ('utilities_on','grounds_open','FS',0),
  ('grounds_open','exterior_furniture','FS',0),
  ('utilities_on','staff_hire','SS',0),
  ('staff_hire','staff_train','FS',0),
  ('linen_restock','soft_open','FS',0),
  ('fb_restock','soft_open','FS',0),
  ('staff_train','soft_open','FS',0),
  ('fire_inspect','soft_open','FS',0),
  ('elevator_inspect','soft_open','FS',0),
  ('pool_permit','soft_open','FS',0),
  ('systems_test','soft_open','FS',0),
  ('exterior_furniture','soft_open','FS',0),
  ('soft_open','open','FS',0)
) AS v(p,s,ty,lag);

-- ── Single-family home build ────────────────────────────────────────────────

WITH t AS (
  INSERT INTO templates (company_id, name, description, category)
  VALUES (NULL, 'Single-family home build',
    'Ground-up residential construction from permits to certificate of occupancy.',
    'construction')
  RETURNING id
), ins AS (
  INSERT INTO template_tasks (template_id, key, name, duration_days, phase_name, sort_order, visibility)
  SELECT t.id, v.key, v.name, v.dur, v.phase, v.ord, v.vis FROM t, (VALUES
    ('permits','Permits and approvals',15,'Pre-construction',10,'client'),
    ('survey','Site survey and staking',2,'Pre-construction',20,'internal'),
    ('clear','Site clearing and excavation',5,'Sitework',30,'internal'),
    ('footings','Footings and foundation',8,'Sitework',40,'internal'),
    ('found_inspect','Foundation inspection',1,'Sitework',50,'internal'),
    ('backfill','Backfill and rough grade',3,'Sitework',60,'internal'),
    ('framing','Framing',15,'Shell',70,'internal'),
    ('roof','Roof sheathing and shingles',6,'Shell',80,'internal'),
    ('windows','Windows and exterior doors',4,'Shell',90,'internal'),
    ('dry_in','Dried in',0,'Shell',100,'client'),
    ('elec_rough','Electrical rough-in',6,'Rough-in',110,'internal'),
    ('plumb_rough','Plumbing rough-in',6,'Rough-in',120,'internal'),
    ('hvac_rough','HVAC rough-in',6,'Rough-in',130,'internal'),
    ('rough_inspect','Rough-in inspections',2,'Rough-in',140,'internal'),
    ('insulation','Insulation',3,'Interior',150,'internal'),
    ('drywall','Drywall hang, tape and finish',12,'Interior',160,'internal'),
    ('interior_paint','Interior paint',6,'Interior',170,'internal'),
    ('cabinets','Cabinets and countertops',6,'Interior',180,'internal'),
    ('interior_trim','Interior trim and doors',6,'Interior',190,'internal'),
    ('flooring','Flooring',7,'Interior',200,'internal'),
    ('fixtures','Plumbing and electrical fixtures',4,'Interior',210,'internal'),
    ('appliances','Appliances',2,'Interior',220,'internal'),
    ('siding','Siding and exterior finishes',8,'Exterior',230,'internal'),
    ('driveway','Driveway and walkways',4,'Exterior',240,'internal'),
    ('landscaping','Landscaping',5,'Exterior',250,'internal'),
    ('punch','Punch list',5,'Closeout',260,'internal'),
    ('final_inspect','Final inspection and certificate of occupancy',2,'Closeout',270,'client'),
    ('handover','Handover to owner',0,'Closeout',280,'client')
  ) AS v(key,name,dur,phase,ord,vis)
  RETURNING template_id
)
INSERT INTO template_dependencies (template_id, predecessor_key, successor_key, type, lag_days)
SELECT t.id, v.p, v.s, v.ty, v.lag FROM t, (VALUES
  ('permits','clear','FS',0),
  ('survey','clear','FS',0),
  ('clear','footings','FS',0),
  ('footings','found_inspect','FS',0),
  ('found_inspect','backfill','FS',0),
  ('found_inspect','framing','FS',0),
  ('framing','roof','FS',-3),
  ('framing','windows','FS',0),
  ('roof','dry_in','FS',0),
  ('windows','dry_in','FS',0),
  ('dry_in','elec_rough','FS',0),
  ('dry_in','plumb_rough','FS',0),
  ('dry_in','hvac_rough','FS',0),
  ('elec_rough','rough_inspect','FS',0),
  ('plumb_rough','rough_inspect','FS',0),
  ('hvac_rough','rough_inspect','FS',0),
  ('rough_inspect','insulation','FS',0),
  ('insulation','drywall','FS',0),
  ('drywall','interior_paint','FS',1),
  ('interior_paint','cabinets','FS',0),
  ('cabinets','interior_trim','FS',0),
  ('interior_trim','flooring','FS',0),
  ('flooring','fixtures','FS',0),
  ('fixtures','appliances','FS',0),
  ('dry_in','siding','FS',0),
  ('backfill','driveway','FS',0),
  ('siding','landscaping','FS',0),
  ('driveway','landscaping','FS',0),
  ('appliances','punch','FS',0),
  ('landscaping','punch','FS',0),
  ('punch','final_inspect','FS',0),
  ('final_inspect','handover','FS',0)
) AS v(p,s,ty,lag);

-- ── Guest room renovation ───────────────────────────────────────────────────

WITH t AS (
  INSERT INTO templates (company_id, name, description, category)
  VALUES (NULL, 'Guest room renovation',
    'Refurbishing a single guest room or a floor of rooms — short, repeatable, and the one most often run back to back.',
    'hospitality')
  RETURNING id
), ins AS (
  INSERT INTO template_tasks (template_id, key, name, duration_days, phase_name, sort_order, visibility)
  SELECT t.id, v.key, v.name, v.dur, v.phase, v.ord, v.vis FROM t, (VALUES
    ('survey','Room survey and measure',1,'Preparation',10,'internal'),
    ('order','Order finishes and FF&E',10,'Preparation',20,'internal'),
    ('strip','Strip out — furniture, carpet, fixtures',2,'Works',30,'internal'),
    ('elec','Electrical alterations',2,'Works',40,'internal'),
    ('plumb','Bathroom plumbing alterations',3,'Works',50,'internal'),
    ('patch','Patch and prep walls',2,'Works',60,'internal'),
    ('tile','Bathroom tile and fixtures',4,'Works',70,'internal'),
    ('paint','Paint',2,'Finishes',80,'internal'),
    ('flooring','Flooring and carpet',2,'Finishes',90,'internal'),
    ('trim','Trim, doors and hardware',2,'Finishes',100,'internal'),
    ('ffe','FF&E install — furniture and soft goods',2,'Finishes',110,'internal'),
    ('av','TV, Wi-Fi and AV setup',1,'Finishes',120,'internal'),
    ('clean','Final clean',1,'Handback',130,'internal'),
    ('inspect','Inspection and snag',1,'Handback',140,'internal'),
    ('ready','Room ready for sale',0,'Handback',150,'client')
  ) AS v(key,name,dur,phase,ord,vis)
  RETURNING template_id
)
INSERT INTO template_dependencies (template_id, predecessor_key, successor_key, type, lag_days)
SELECT t.id, v.p, v.s, v.ty, v.lag FROM t, (VALUES
  ('survey','order','FS',0),
  ('order','strip','FS',0),
  ('strip','elec','FS',0),
  ('strip','plumb','FS',0),
  ('elec','patch','FS',0),
  ('plumb','tile','FS',0),
  ('patch','paint','FS',0),
  ('tile','paint','FS',0),
  ('paint','flooring','FS',0),
  ('flooring','trim','FS',0),
  ('trim','ffe','FS',0),
  ('ffe','av','FS',0),
  ('av','clean','FS',0),
  ('clean','inspect','FS',0),
  ('inspect','ready','FS',0)
) AS v(p,s,ty,lag);
