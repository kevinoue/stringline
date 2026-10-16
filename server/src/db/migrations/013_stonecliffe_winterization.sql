-- The Inn at Stonecliffe — winterization.
--
-- Built from the 2025 season's schedule and checklist, which existed as two
-- overlapping documents that disagreed with each other in places. This is the
-- formalised version: one task per building or area, with the procedure as its
-- steps, in the order the work actually has to happen.
--
-- Three things were added that the 2025 documents did not have, because they
-- are the constraints that bite:
--
--   * **Carpets before water.** Extraction needs running water, so carpet
--     cleaning has to finish before any shutoff. Doing it the other way round
--     means either dirty carpets all winter or turning the water back on.
--   * **Laundry before the Summer House.** The laundry room is in the Summer
--     House, so every linen on the property has to be washed, dried and put
--     away before that building can be drained. It is why the Summer House is
--     last on the 2025 schedule, and nothing wrote down why.
--   * **Rooms stripped before anything.** Linen has to come out before it can
--     be washed, and rooms have to be clear before they can be winterised.
--
-- Spelling corrected throughout ("Mainsion", "coup"), and the two documents
-- reconciled where they disagreed — thermostat setpoints in particular, where
-- the schedule said 68°F and the checklist said 64°F for the same buildings.
-- 68°F is used here; the real figure is worth confirming once.
--
-- Named individuals from the source documents are deliberately left out. The
-- instructions they attach to are kept.

WITH t AS (
  INSERT INTO templates (company_id, name, description, category)
  VALUES (NULL, 'Inn at Stonecliffe — winterization',
    'A seasonal island property closing for winter: housekeeping and laundry first, then every building drained, blown out and heated down, ending with the Summer House because the laundry lives in it.',
    'hospitality')
  RETURNING id
), ins AS (
  INSERT INTO template_tasks
    (template_id, key, name, duration_days, phase_name, category_name, sort_order, visibility)
  SELECT t.id, v.key, v.name, v.dur, v.phase, v.cat, v.ord, v.vis FROM t, (VALUES

    -- ── Wind-down ───────────────────────────────────────────────────────────
    ('departures','Final guest departures',1,'Wind-down','Front office',10,'client'),
    ('tenants_out','Departing tenants out of Tulecki House and Old Barn',1,'Wind-down','Admin',20,'internal'),
    ('staff_offboard','Seasonal staff offboarding and final payroll',2,'Wind-down','Admin',30,'internal'),

    -- ── Housekeeping ────────────────────────────────────────────────────────
    -- This phase gates every water shutoff on the property.
    ('strip_rooms','Strip all guest rooms and staff housing',3,'Housekeeping','Housekeeping',40,'internal'),
    ('clean_carpets','Clean all carpets and upholstery',3,'Housekeeping','Housekeeping',50,'internal'),
    ('final_laundry','Final laundry — wash, dry and store all linens',4,'Housekeeping','Housekeeping',60,'internal'),
    ('hk_store','Store housekeeping stock, chemicals and equipment',1,'Housekeeping','Housekeeping',70,'internal'),

    -- ── Food and beverage ───────────────────────────────────────────────────
    ('perishables','Dispose or transfer all perishables',1,'Food and beverage','Food and beverage',80,'internal'),
    ('fb_inventory','F&B and bar inventory count',2,'Food and beverage','Food and beverage',90,'internal'),
    ('walkins_down','Empty, defrost and shut down walk-ins',2,'Food and beverage','Food and beverage',100,'internal'),
    ('kitchen_clean','Kitchen deep clean and degrease',3,'Food and beverage','Food and beverage',110,'internal'),
    ('bar_shutdown','Mansion bar shutdown',1,'Food and beverage','Food and beverage',120,'internal'),

    -- ── Pools ───────────────────────────────────────────────────────────────
    ('adult_pool','Winterize adult pool',4,'Pools','Maintenance',130,'internal'),
    ('kids_pool','Winterize kids pool',3,'Pools','Maintenance',140,'internal'),

    -- ── Outbuildings, first wave ────────────────────────────────────────────
    ('wellness','Winterize Wellness Center',4,'Outbuildings','Maintenance',150,'internal'),
    ('event_center','Close Event Center',3,'Outbuildings','Maintenance',160,'internal'),
    ('bbq_pavilion','Close BBQ Pavilion',4,'Outbuildings','Maintenance',170,'internal'),
    ('cottages','Winterize Cottages and Love Shack',5,'Outbuildings','Maintenance',180,'internal'),
    ('maintenance_area','Close maintenance area for winter',2,'Outbuildings','Maintenance',190,'internal'),
    ('fuel_offisland','Send diesel and gas fuel pods off-island',1,'Outbuildings','Admin',200,'internal'),
    ('septic','Septic cleaning — Tulecki House',1,'Outbuildings','Contractors',210,'internal'),
    ('tulecki','Winterize Tulecki House',3,'Outbuildings','Maintenance',220,'internal'),
    ('old_barn','Close Old Barn',2,'Outbuildings','Maintenance',230,'internal'),

    -- ── Staff housing and Mansion ───────────────────────────────────────────
    ('greenshed','Winterize Greenshed housing',4,'Staff housing and Mansion','Maintenance',240,'internal'),
    ('mansion','Winterize Mansion',5,'Staff housing and Mansion','Maintenance',250,'internal'),
    ('statues','Build protective boxes around the front statues',2,'Staff housing and Mansion','Grounds',260,'internal'),

    -- ── Summer House ────────────────────────────────────────────────────────
    -- Last, and not by accident: the laundry room is in this building.
    ('boiler_decision','Confirm whether the HVAC boilers may be shut down or held at minimum',1,'Summer House','Admin',270,'internal'),
    ('summerhouse','Winterize Summer House',6,'Summer House','Maintenance',280,'internal'),

    -- ── Site and handover ───────────────────────────────────────────────────
    ('security_check','Security system and camera check',1,'Site and handover','Maintenance',290,'internal'),
    ('snow_contract','Confirm snow removal and caretaking contract',1,'Site and handover','Admin',300,'internal'),
    ('utility_readings','Final utility readings, switch to seasonal accounts',1,'Site and handover','Admin',310,'internal'),
    ('final_walk','Property walk-through and photo record',2,'Site and handover','Admin',320,'client'),
    ('closed','Property secured for the season',0,'Site and handover',NULL,330,'client'),

    -- ── Review each year ────────────────────────────────────────────────────
    -- Carried over from 2025 but not part of winterising anything. Kept so it
    -- is not forgotten, in its own phase so it is easy to delete.
    ('chicken_coop','Build the chicken enclosure for the coming flock',3,'Review each year','Grounds',340,'internal')

  ) AS v(key, name, dur, phase, cat, ord, vis)
  RETURNING template_id
)
INSERT INTO template_dependencies (template_id, predecessor_key, successor_key, type, lag_days)
SELECT t.id, v.pred, v.succ, v.type, v.lag FROM t, (VALUES

  -- Nothing starts until the last guest is off the property.
  ('departures','strip_rooms','FS',0),
  ('departures','perishables','FS',0),
  ('departures','adult_pool','FS',0),
  ('departures','kids_pool','FS',0),
  ('departures','staff_offboard','FS',0),
  ('tenants_out','tulecki','FS',0),
  ('tenants_out','old_barn','FS',0),
  ('tenants_out','septic','FS',0),
  ('septic','tulecki','FS',0),

  -- Housekeeping, in the only order that works.
  ('strip_rooms','clean_carpets','FS',0),
  ('strip_rooms','final_laundry','FS',0),
  ('final_laundry','hk_store','FS',0),

  -- Kitchen and bar.
  ('perishables','fb_inventory','FS',0),
  ('perishables','walkins_down','FS',0),
  ('walkins_down','kitchen_clean','FS',0),
  ('fb_inventory','bar_shutdown','FS',0),

  -- The Wellness Center stores its washed pool furniture in the Event Center,
  -- so the Event Center cannot be closed until that is done. It does *not*
  -- wait on the main pools — they are separate crews on separate buildings,
  -- and chaining them stretched the first week by four days for no reason.
  ('departures','wellness','FS',0),
  ('wellness','event_center','FS',0),

  ('departures','bbq_pavilion','FS',0),
  ('departures','maintenance_area','FS',0),
  ('maintenance_area','fuel_offisland','FS',0),

  -- CARPETS BEFORE WATER. Extraction needs running water, so every building
  -- with carpet has to wait for it.
  ('clean_carpets','cottages','FS',0),
  ('clean_carpets','greenshed','FS',0),
  ('clean_carpets','mansion','FS',0),
  ('clean_carpets','summerhouse','FS',0),

  -- Second wave.
  ('cottages','greenshed','FS',0),
  ('greenshed','mansion','FS',0),
  ('bar_shutdown','mansion','FS',0),
  ('mansion','statues','FS',0),

  -- LAUNDRY BEFORE THE SUMMER HOUSE. The laundry room is in it.
  ('final_laundry','summerhouse','FS',0),
  ('mansion','summerhouse','FS',0),
  ('boiler_decision','summerhouse','FS',0),
  ('hk_store','summerhouse','FS',0),

  -- Handover.
  ('summerhouse','security_check','FS',0),
  ('event_center','security_check','FS',0),
  ('bbq_pavilion','security_check','FS',0),
  ('tulecki','security_check','FS',0),
  ('old_barn','security_check','FS',0),
  ('kids_pool','security_check','FS',0),
  ('kitchen_clean','security_check','FS',0),
  ('fuel_offisland','security_check','FS',0),
  ('security_check','snow_contract','FS',0),
  ('security_check','utility_readings','FS',0),
  ('snow_contract','final_walk','FS',0),
  ('utility_readings','final_walk','FS',0),
  ('statues','final_walk','FS',0),
  ('final_walk','closed','FS',0)

) AS v(pred, succ, type, lag);


-- ── Steps ───────────────────────────────────────────────────────────────────
--
-- The procedure inside each task. Steps with days are the physical work and
-- add up to the task's duration; zero-day steps are tick-boxes — the checks,
-- settings and notes that happen within the work rather than taking time of
-- their own.
--
-- Most buildings share the same core: furniture in, appliances unplugged,
-- lines drained and blown out at no more than 50 PSI, faucets and drains left
-- open, heat set. That repetition is the point — it is one procedure applied
-- to twelve buildings, and writing it once per building is how a checklist
-- ends up disagreeing with itself.

INSERT INTO template_steps (template_id, task_key, name, duration_days, sort_order)
SELECT (SELECT id FROM templates WHERE name = 'Inn at Stonecliffe — winterization'),
       v.task, v.name, v.dur, v.ord
FROM (VALUES

  -- Housekeeping ─────────────────────────────────────────────────────────────
  ('strip_rooms','Strip beds and bag all linens for the laundry',1,10),
  ('strip_rooms','Clear amenities, consumables and minibars',1,20),
  ('strip_rooms','Log damage, breakages and missing items',1,30),
  ('strip_rooms','Confirm every room and staff unit is clear',0,40),

  ('clean_carpets','Extract guest room carpets',1,10),
  ('clean_carpets','Extract corridor and public area carpets',1,20),
  ('clean_carpets','Clean upholstery and soft furnishings',1,30),
  ('clean_carpets','Allow full dry time before any water is shut off',0,40),

  ('final_laundry','Wash and dry all bed linens',2,10),
  ('final_laundry','Wash and dry all towels and pool linens',1,20),
  ('final_laundry','Fold and store linens in the Summer House linen store',1,30),
  ('final_laundry','Clean lint traps and drain the machines',0,40),
  ('final_laundry','Confirm nothing is left in the laundry room',0,50),

  -- Food and beverage ────────────────────────────────────────────────────────
  ('bar_shutdown','Empty, clean and unplug the coolers',1,10),
  ('bar_shutdown','Pull the coolers out and inspect behind them',0,20),
  ('bar_shutdown','Remove and inventory all stock',0,30),
  ('bar_shutdown','Clean, dry and store the glassware',0,40),

  -- Pools ────────────────────────────────────────────────────────────────────
  ('adult_pool','Confirm dates with the pool service contractor',0,10),
  ('adult_pool','Drain the pool',1,20),
  ('adult_pool','Pressure wash the pool surfaces and deck',1,30),
  ('adult_pool','Blow out and shut off the supply lines',1,40),
  ('adult_pool','Blow out and winterize the heat pump, cover with plywood',1,50),
  ('adult_pool','Refill to at least two feet of water',0,60),
  ('adult_pool','Drain and blow out the bathrooms',0,70),
  ('adult_pool','Add antifreeze to the bathroom fixtures',0,80),
  ('adult_pool','Clean the mechanical room and inspect the equipment',0,90),
  ('adult_pool','Call the Water Department to have the meter pulled',0,100),

  ('kids_pool','Drain the pool',1,10),
  ('kids_pool','Blow out and shut off the supply lines',1,20),
  ('kids_pool','Blow out and winterize the heat pump, cover with plywood',1,30),
  ('kids_pool','Refill to at least two feet of water',0,40),
  ('kids_pool','Clean the mechanical room and note defective equipment',0,50),

  -- Outbuildings ─────────────────────────────────────────────────────────────
  ('wellness','Power-wash the pool furniture and store it in the Event Center',1,10),
  ('wellness','Power-wash the pool decking',1,20),
  ('wellness','Bring porch furniture inside',0,30),
  ('wellness','Drain the water lines and blow out at no more than 50 PSI',1,40),
  ('wellness','Leave the faucets and drains open',0,50),
  ('wellness','Secure doors, windows, blinds and curtains',1,60),
  ('wellness','Set the thermostat to 68°F',0,70),

  ('event_center','Clear the mechanical room',1,10),
  ('event_center','Lay floor protection',1,20),
  ('event_center','Bring in all three mobile bars',1,30),
  ('event_center','Bring in the outdoor pool furniture',0,40),
  ('event_center','Bring in the bicycles from the bike pavilion',0,50),
  ('event_center','Store the Sperry tent poles',0,60),
  ('event_center','Shut down the HVAC unit',0,70),
  ('event_center','Set the sprinkler room to 68°F and verify the baseboard heater',0,80),

  ('bbq_pavilion','Turn off, unplug and inspect the coolers',1,10),
  ('bbq_pavilion','Turn off the water and blow out the lines',1,20),
  ('bbq_pavilion','Inspect and close the motorized blinds',1,30),
  ('bbq_pavilion','Frame and sheet the plastic enclosure',1,40),
  ('bbq_pavilion','Install plywood protection on the swing doors',0,50),
  ('bbq_pavilion','Leave the motorized blinds up two feet',0,60),

  ('cottages','Inspect the equipment and note major issues',1,10),
  ('cottages','Verify HVAC, electrical and plumbing',1,20),
  ('cottages','Bring porch furniture inside',1,30),
  ('cottages','Unplug appliances, drain the icemakers and shut off their supply',1,40),
  ('cottages','Drain the water lines and blow out at no more than 50 PSI',1,50),
  ('cottages','Leave the faucets and drains open',0,60),
  ('cottages','Set the thermostats to 68°F',0,70),

  ('maintenance_area','Seal the trifold and sliding barn doors with plastic',1,10),
  ('maintenance_area','Store loose items and deliveries in the connexes and tents',1,20),
  ('maintenance_area','Park the Toro, golf cart and Avant in the centre bay',0,30),
  ('maintenance_area','Park the Kubota in the maintenance garage',0,40),
  ('maintenance_area','Set the barn and garage thermostats to 65°F',0,50),
  ('maintenance_area','Put the golf cart on its battery maintainer',0,60),

  ('tulecki','Inspect HVAC, electrical and plumbing',1,10),
  ('tulecki','Blow out the water lines',1,20),
  ('tulecki','Add antifreeze to the fixtures',1,30),
  ('tulecki','Unplug the appliances on the second and third floors',0,40),
  ('tulecki','Close the crawlspace vents',0,50),
  ('tulecki','Note any windows missing screens',0,60),
  ('tulecki','Call the Water Department to have the meter pulled',0,70),

  ('old_barn','Close the vents',1,10),
  ('old_barn','Install the snowmobile barriers',1,20),
  ('old_barn','Turn the heat down in the unoccupied rooms',0,30),
  ('old_barn','Note any windows missing screens',0,40),

  -- Staff housing and Mansion ────────────────────────────────────────────────
  ('greenshed','Shut off the water',1,10),
  ('greenshed','Drain the water lines and blow out at no more than 50 PSI',1,20),
  ('greenshed','Shut off the electrical, then the heat',1,30),
  ('greenshed','Verify the crawlspace heaters are running',1,40),
  ('greenshed','Set the sprinkler room to 68°F',0,50),
  ('greenshed','Note any windows missing screens',0,60),

  ('mansion','Remove the window screens and store them in the bathrooms',1,10),
  ('mansion','Unplug the appliances and note major issues',1,20),
  ('mansion','Drain and disconnect the dishwashers and coffee makers',1,30),
  ('mansion','Drain the water lines and equipment, blow out at no more than 50 PSI',1,40),
  ('mansion','Repeat the blowout the following day',1,50),
  ('mansion','Turn off, unplug and pull out the coolers to inspect behind',0,60),
  ('mansion','Leave the faucets and drains open',0,70),
  ('mansion','Keep the bar heated and sheet the bar doors in plastic',0,80),
  ('mansion','Set the sprinkler room to 68°F',0,90),
  ('mansion','Set every other area of the Mansion to 50°F',0,100),

  -- Summer House ─────────────────────────────────────────────────────────────
  ('summerhouse','Remove the window screens and store them in the bathrooms',1,10),
  ('summerhouse','Drain the washing machines and disconnect the water hoses',1,20),
  ('summerhouse','Winterize all water-using equipment',1,30),
  ('summerhouse','Gravity-drain the building',1,40),
  -- A day each, and in this order: "repeat the following day" is not a
  -- tick-box, it is a second day of work that cannot happen on the first.
  ('summerhouse','Drain the water lines and equipment, blow out at no more than 50 PSI',1,50),
  ('summerhouse','Repeat the blowout the following day',1,60),
  ('summerhouse','Bring the patio furniture inside',0,70),
  ('summerhouse','Blow out the HVAC drains',0,80),
  ('summerhouse','Unplug the appliances and note major issues',0,90),
  ('summerhouse','Leave the faucets and drains open',0,100),
  ('summerhouse','Keep the elevator machine room heated and the elevator powered',0,110),
  ('summerhouse','Leave the lights on around the elevator',0,120),
  ('summerhouse','Fit the heat strip in the second floor valley and gutters',0,130),
  ('summerhouse','Set the sprinkler room to 68°F',0,140),

  -- Handover ─────────────────────────────────────────────────────────────────
  ('final_walk','Walk every building and photograph its condition',1,10),
  ('final_walk','Confirm every faucet and drain is open',0,20),
  ('final_walk','Confirm every sprinkler room is at temperature',0,30),
  ('final_walk','Confirm the caretaker has keys and contacts',1,40)

) AS v(task, name, dur, ord);
