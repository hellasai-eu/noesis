-- Add father_name and date_of_birth to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS father_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS date_of_birth date;

-- Allow admins to update profiles of users in the same institution
-- (needed for editing father_name/dob on student profiles from UserManagement)
CREATE POLICY "Admins can update profiles in their institution"
  ON public.profiles FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM user_institutions admin_ui
      JOIN user_institutions target_ui ON target_ui.user_id = profiles.user_id
        AND target_ui.institution_id = admin_ui.institution_id
      WHERE admin_ui.user_id = auth.uid()
        AND admin_ui.role = 'admin'
    )
  );
