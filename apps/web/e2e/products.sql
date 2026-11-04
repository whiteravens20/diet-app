-- The products the browser tests look for: an instance's table as an import leaves it,
-- so that no test depends on Open Food Facts. Given to the database before a run.
INSERT INTO "Product" (
  "id", "code", "name", "brand", "searchText", "pack", "unit", "packAmount", "servingAmount",
  "calories", "protein", "fat", "carbs", "fiber", "sugars", "salt", "saturatedFat",
  "doubtful", "origin", "popularity"
) VALUES
  ('e2e00000-0000-4000-8000-000000000001', '5900512320359', 'Mleko próbne 3,2%', 'Próbna Marka',
   'mleko probne 3 2 probna marka', '1 l', 'ml', 1000, 250,
   60, 3.2, 3.2, 4.7, NULL, 4.7, 0.1, 2.1, false, 'imported', 9),
  ('e2e00000-0000-4000-8000-000000000002', '5901234123457', 'Baton próbny', 'Próbna Marka',
   'baton probny probna marka', '50 g', 'g', 50, NULL,
   176, 8, 20, 62, NULL, NULL, NULL, NULL, true, 'imported', 5),
  ('e2e00000-0000-4000-8000-000000000003', '4001724819806', 'Bez etykiety próbny', NULL,
   'bez etykiety probny', NULL, 'g', NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, 'looked_up', 0)
ON CONFLICT ("code") DO NOTHING;
