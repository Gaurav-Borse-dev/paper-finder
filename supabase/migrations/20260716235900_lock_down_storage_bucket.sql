-- Migration to lock down storage policies for the papers bucket
-- This drops the wide-open public policies from Migration 2.

DROP POLICY IF EXISTS "papers bucket public read" ON storage.objects;
DROP POLICY IF EXISTS "papers bucket public insert" ON storage.objects;
DROP POLICY IF EXISTS "papers bucket public update" ON storage.objects;
DROP POLICY IF EXISTS "papers bucket public delete" ON storage.objects;
