-- Migration to seed/reset the admin user credentials
DO $$
DECLARE
  _user_id uuid := 'a3e0f98e-4a6c-48c6-b3a1-77d46c82729a';
  _email text := 'admin@papervault.app';
  _encrypted_password text;
BEGIN
  -- Generate the encrypted password using bcrypt (pgcrypto)
  BEGIN
    _encrypted_password := extensions.crypt('2722006@gb', extensions.gen_salt('bf'));
  EXCEPTION WHEN OTHERS THEN
    _encrypted_password := crypt('2722006@gb', gen_salt('bf'));
  END;

  -- 1. Insert or update the user in auth.users
  -- Excluding the generated column "confirmed_at" which PostgreSQL handles automatically.
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = _email) THEN
    INSERT INTO auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      phone,
      phone_confirmed_at
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      _user_id,
      'authenticated',
      'authenticated',
      _email,
      _encrypted_password,
      now(),
      '{"provider": "email", "providers": ["email"]}',
      '{"name": "Admin User"}',
      now(),
      now(),
      null,
      null
    );

    -- 2. Insert into auth.identities to link the email login provider
    INSERT INTO auth.identities (
      id,
      user_id,
      identity_data,
      provider,
      last_sign_in_at,
      created_at,
      updated_at
    ) VALUES (
      _user_id,
      _user_id,
      format('{"sub":"%s","email":"%s"}', _user_id, _email)::jsonb,
      'email',
      now(),
      now(),
      now()
    );
  ELSE
    -- If user already exists, update their password and confirm their email
    UPDATE auth.users
    SET encrypted_password = _encrypted_password,
        email_confirmed_at = now(),
        updated_at = now()
    WHERE email = _email;
  END IF;

  -- 3. Explicitly ensure user_roles has the admin role for this user
  INSERT INTO public.user_roles (user_id, role)
  SELECT id, 'admin' FROM auth.users WHERE email = _email
  ON CONFLICT DO NOTHING;
  
  -- Clean up from pending_admins if it is still there
  DELETE FROM public.pending_admins WHERE lower(email) = lower(_email);
END $$;
