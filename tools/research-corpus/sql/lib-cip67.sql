-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Adam K. Dean
--
-- CIP-67 asset name labels, and the asset classification rule of the
-- pre-registration (section 6.2): a valid CIP-67 label decides (333 and 444
-- fungible; 222, 100 and 500 non-fungible unless more than one unit is held),
-- otherwise more than one unit held makes an asset fungible.
--
-- CIP-67 (cardano-foundation/CIPs@befcdb75289cb6571ffba6dbece3249ad2bfd491,
-- CIP-0067/README.md, "Specification"): the asset name starts with four bytes
--   [ 0000 | 16 bits label_num | 8 bits checksum | 0000 ]
-- where the checksum is CRC-8 with polynomial 0x07 over the two label_num bytes
-- (the lookup table below is the one the CIP prints, beginning 0x00, 0x07,
-- 0x0e). The registry (CIP-0067/registry.json at the same commit) holds 100,
-- 222 and 500 (class NFT), 333 (FT) and 444 (RFT). CIP-68 puts the prefix in
-- front of the asset name content; CIP-102 royalty NFTs start 001f4d70.
--
-- Bit layout of the first four bytes b0 b1 b2 b3:
--   b0 high nibble 0; label = (b0 & 0x0f) << 12 | b1 << 4 | b2 >> 4;
--   checksum = (b2 & 0x0f) << 4 | b3 >> 4; b3 low nibble 0.

-- @lib cip67
-- The CRC-8 lookup table of CIP-67 (polynomial 0x07), as printed in the CIP.
CREATE OR REPLACE FUNCTION study.crc8_table() RETURNS integer[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY[
      0, 7, 14, 9, 28, 27, 18, 21, 56, 63, 54, 49, 36,
      35, 42, 45, 112, 119, 126, 121, 108, 107, 98, 101, 72, 79,
      70, 65, 84, 83, 90, 93, 224, 231, 238, 233, 252, 251, 242,
      245, 216, 223, 214, 209, 196, 195, 202, 205, 144, 151, 158, 153,
      140, 139, 130, 133, 168, 175, 166, 161, 180, 179, 186, 189, 199,
      192, 201, 206, 219, 220, 213, 210, 255, 248, 241, 246, 227, 228,
      237, 234, 183, 176, 185, 190, 171, 172, 165, 162, 143, 136, 129,
      134, 147, 148, 157, 154, 39, 32, 41, 46, 59, 60, 53, 50,
      31, 24, 17, 22, 3, 4, 13, 10, 87, 80, 89, 94, 75,
      76, 69, 66, 111, 104, 97, 102, 115, 116, 125, 122, 137, 142,
      135, 128, 149, 146, 155, 156, 177, 182, 191, 184, 173, 170, 163,
      164, 249, 254, 247, 240, 229, 226, 235, 236, 193, 198, 207, 200,
      221, 218, 211, 212, 105, 110, 103, 96, 117, 114, 123, 124, 81,
      86, 95, 88, 77, 74, 67, 68, 25, 30, 23, 16, 5, 2,
      11, 12, 33, 38, 47, 40, 61, 58, 51, 52, 78, 73, 64,
      71, 82, 85, 92, 91, 118, 113, 120, 127, 106, 109, 100, 99,
      62, 57, 48, 55, 34, 37, 44, 43, 6, 1, 8, 15, 26,
      29, 20, 19, 174, 169, 160, 167, 178, 181, 188, 187, 150, 145,
      152, 159, 138, 141, 132, 131, 222, 217, 208, 215, 194, 197, 204,
      203, 230, 225, 232, 239, 250, 253, 244, 243]::integer[]
$$;

-- CRC-8, polynomial 0x07, initial value 0, no reflection, no final XOR, over
-- the two bytes hi and lo: crc = T[T[hi] xor lo]. Written without a FROM clause
-- so the planner inlines it and folds the table.
CREATE OR REPLACE FUNCTION study.crc8_2(hi integer, lo integer) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT (study.crc8_table())[((study.crc8_table())[hi + 1] # lo) + 1]
$$;

-- The CIP-67 label of an asset name, or NULL when the name has fewer than four
-- bytes, a non-zero bracket nibble, or a checksum that does not match. The
-- nested CASE keeps get_byte from running on names shorter than four bytes.
CREATE OR REPLACE FUNCTION study.cip67_label(name bytea) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN length(name) < 4 THEN NULL ELSE
           CASE WHEN (get_byte(name, 0) >> 4) = 0
                 AND (get_byte(name, 3) & 15) = 0
                 AND study.crc8_2(((get_byte(name, 0) & 15) << 4) | (get_byte(name, 1) >> 4),
                                  ((get_byte(name, 1) & 15) << 4) | (get_byte(name, 2) >> 4))
                     = (((get_byte(name, 2) & 15) << 4) | (get_byte(name, 3) >> 4))
                THEN ((get_byte(name, 0) & 15) << 12) | (get_byte(name, 1) << 4) | (get_byte(name, 2) >> 4)
           END
         END
$$;

-- The rule of section 6.2 for an asset held as `qty` units in total by one
-- wallet: fungible when its label is 333 or 444, or when more than one unit is
-- held; otherwise non-fungible. (A 100, 222 or 500 label is non-fungible unless more
-- than one unit is held; an unlabeled asset is fungible only above one unit;
-- labels outside the five, such as 600 and 601 proposed in CIPs pull request
-- 1207, fall to the quantity rule.)
CREATE OR REPLACE FUNCTION study.is_fungible(name bytea, qty numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT coalesce(study.cip67_label(name) IN (333, 444), false) OR qty > 1
$$;

-- The same rule for an asset whose label is already known (study.asset.label).
CREATE OR REPLACE FUNCTION study.is_fungible_l(label integer, qty numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(label IN (333, 444), false) OR qty > 1
$$;
