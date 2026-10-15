-- Printing.
--
-- A construction schedule is a printed artefact as much as a screen: pinned up
-- in a site trailer, or sent to a client as a PDF. What a printed drawing needs
-- and a screen does not is a title block — the line that says which revision
-- this is and what it was issued for.

-- Free text for the title block, under the project name. "Rev C — issued for
-- construction", "Week 14 progress review", that sort of thing. Kept on the
-- project rather than asked for on every print, because retyping it each time
-- is exactly the friction that stops people using a feature.
ALTER TABLE projects ADD COLUMN print_subtitle TEXT;

-- An override for the heading itself. Normally the project name is right, so
-- this stays NULL and the name is used — but the name a company files a job
-- under is not always the name a client should see on a drawing.
ALTER TABLE projects ADD COLUMN print_title TEXT;
