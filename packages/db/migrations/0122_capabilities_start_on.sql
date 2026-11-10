-- Owner decision, 2026-11-09: connecting an account means Josi may use it.
-- Until now every capability started off, so an account connected before this
-- change could not read mail until each switch was found and turned on. Turn
-- on, once, what the provider has already granted; the switches stay where
-- people can turn any of it off. What an administrator switched off for the
-- whole installation stays off for everyone but the owner.
update connection_capabilities cc set enabled = true
  from connections c
 where c.id = cc.connection_id and cc.enabled = false and cc.scopes_granted_at is not null
   and (not exists (select 1 from admin_capability_policy p where p.capability = cc.capability and not p.allowed)
        or exists (select 1 from users u where u.id = c.owner_user_id and u.role = 'super_admin'));
