-- =============================================================================
-- 0015 · Tenant provisioning
--
-- Creating a business is the one operation that must run before its own access rules can
-- apply — there is no member yet to authorise it. It therefore runs as a SECURITY DEFINER
-- function callable only by a platform administrator, and does the whole job atomically:
-- a tenant with no owner, or with roles but no permissions, is a broken account someone
-- has to repair by hand.
-- =============================================================================

create or replace function provision_tenant(
  p_slug          text,
  p_name          text,
  p_owner_email   text,
  p_owner_name    text,
  p_owner_user_id uuid,
  p_branch_name   text default 'Main Branch',
  p_branch_code   text default 'main',
  p_status        tenant_status default 'TRIAL',
  p_trial_days    integer default 14
)
returns table (tenant_id uuid, branch_id uuid, membership_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id     uuid;
  v_branch_id     uuid;
  v_membership_id uuid;
  v_role_id       uuid;
  v_owner_role_id uuid;
  v_template      record;
begin
  -- Only platform staff provision tenants. Without this check the function's SECURITY
  -- DEFINER privileges would be available to every authenticated user.
  if not app.is_platform_admin() then
    raise exception 'PERMISSION_DENIED'
      using detail = 'Only a Carl platform administrator may provision a tenant.';
  end if;

  if p_owner_user_id is null then
    raise exception 'VALIDATION_FAILED' using detail = 'An owner account is required.';
  end if;

  insert into public.tenants (slug, name, status, trial_ends_at)
  values (
    p_slug,
    p_name,
    p_status,
    case when p_status = 'TRIAL' then now() + make_interval(days => p_trial_days) end
  )
  returning id into v_tenant_id;

  insert into public.branches (tenant_id, code, name, is_default)
  values (v_tenant_id, p_branch_code, p_branch_name, true)
  returning id into v_branch_id;

  -- The owner's profile may already exist (a person can own several businesses).
  insert into public.profiles (id, email, full_name)
  values (p_owner_user_id, p_owner_email, p_owner_name)
  on conflict (id) do nothing;

  -- Copy every system role template into this tenant, with its permissions.
  for v_template in
    select key, name, description, rank from public.role_templates order by rank
  loop
    insert into public.roles (tenant_id, key, name, description, rank, is_system)
    values (v_tenant_id, v_template.key, v_template.name, v_template.description, v_template.rank, true)
    returning id into v_role_id;

    insert into public.role_permissions (role_id, permission_key)
    select v_role_id, tp.permission_key
    from public.role_template_permissions tp
    where tp.template_key = v_template.key;

    if v_template.key = 'tenant_owner' then
      v_owner_role_id := v_role_id;
    end if;
  end loop;

  -- Without this the owner would be granted a null role, and the integrity trigger would
  -- report CROSS_TENANT_REFERENCE — an error with no visible connection to the real cause.
  if v_owner_role_id is null then
    raise exception 'INTERNAL_ERROR'
      using detail = 'No tenant_owner role template is seeded. Run the role template migration.';
  end if;

  insert into public.tenant_memberships (tenant_id, user_id, status, is_owner, accepted_at)
  values (v_tenant_id, p_owner_user_id, 'ACTIVE', true, now())
  returning id into v_membership_id;

  -- Tenant-wide, so the owner is not confined to the first branch.
  insert into public.membership_roles (membership_id, role_id, branch_id)
  values (v_membership_id, v_owner_role_id, null);

  insert into public.cash_registers (tenant_id, branch_id, name)
  values (v_tenant_id, v_branch_id, 'Main Register');

  insert into public.audit_logs (tenant_id, branch_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_tenant_id, v_branch_id, auth.uid(), 'TENANT_PROVISIONED', 'tenant', v_tenant_id,
    jsonb_build_object('slug', p_slug, 'owner_user_id', p_owner_user_id)
  );

  return query select v_tenant_id, v_branch_id, v_membership_id;
end;
$$;

comment on function provision_tenant is
  'Creates a tenant, default branch, system roles and owner membership atomically. Platform admin only.';

revoke execute on function provision_tenant from public, anon;
grant execute on function provision_tenant to authenticated, service_role;
