-- ============================================================
-- Book.app - Supabase Database Schema
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- ── Salons ──
CREATE TABLE salons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT DEFAULT '',
  color TEXT DEFAULT '#1a1a2e',
  accent TEXT DEFAULT '#e94560',
  logo TEXT DEFAULT '✂️',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  hours JSONB DEFAULT '{"mon":"09:00-18:00","tue":"09:00-18:00","wed":"09:00-18:00","thu":"09:00-18:00","fri":"09:00-18:00","sat":"10:00-16:00","sun":"Closed"}',
  holidays TEXT[] DEFAULT '{}',
  out_of_hours JSONB DEFAULT '{"enabled":false,"slots":[]}',
  notification_settings JSONB DEFAULT '{"reminderHours":[24,2],"confirmations":true,"cancellationNotify":true,"waitlistNotify":true}',
  owner_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── Staff ──
CREATE TABLE staff (
  id TEXT NOT NULL,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  avatar TEXT DEFAULT '🧑',
  color TEXT DEFAULT '#6366f1',
  email TEXT,
  availability JSONB DEFAULT '{}',
  PRIMARY KEY (id, salon_id)
);

-- ── Services ──
CREATE TABLE services (
  id TEXT NOT NULL,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 30,
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  category TEXT DEFAULT '',
  PRIMARY KEY (id, salon_id)
);

-- ── Clients ──
CREATE TABLE clients (
  id TEXT NOT NULL,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  visits INTEGER DEFAULT 0,
  last_visit TEXT DEFAULT '',
  no_shows INTEGER DEFAULT 0,
  PRIMARY KEY (id, salon_id)
);

-- ── Bookings ──
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  duration INTEGER NOT NULL DEFAULT 30,
  client_name TEXT NOT NULL,
  client_phone TEXT DEFAULT '',
  client_email TEXT DEFAULT '',
  status TEXT DEFAULT 'confirmed',
  surcharge NUMERIC(10,2) DEFAULT 0,
  added_by TEXT DEFAULT 'customer',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── Reviews ──
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  booking_id TEXT,
  client_email TEXT NOT NULL,
  client_name TEXT NOT NULL,
  staff_id TEXT,
  service_id TEXT,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  text TEXT DEFAULT '',
  owner_response TEXT,
  owner_responded_at TIMESTAMPTZ,
  hidden BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── Waitlist ──
CREATE TABLE waitlist (
  id TEXT PRIMARY KEY,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  client_email TEXT DEFAULT '',
  client_phone TEXT DEFAULT '',
  staff_id TEXT,
  service_id TEXT NOT NULL,
  preferred_date TEXT NOT NULL,
  preferred_time_range JSONB DEFAULT '{"from":"morning","to":"any"}',
  status TEXT DEFAULT 'waiting' CHECK (status IN ('waiting','notified','booked','expired')),
  notified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── Notifications ──
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  channel TEXT DEFAULT 'email',
  recipient_email TEXT DEFAULT '',
  recipient_phone TEXT DEFAULT '',
  recipient_name TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  status TEXT DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  scheduled_for TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  booking_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── Notification Templates ──
CREATE TABLE notification_templates (
  id TEXT PRIMARY KEY,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  active BOOLEAN DEFAULT true
);

-- ── OOH Requests ──
CREATE TABLE ooh_requests (
  id TEXT PRIMARY KEY,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  client_email TEXT DEFAULT '',
  client_phone TEXT DEFAULT '',
  service_id TEXT NOT NULL,
  requested_date TEXT NOT NULL,
  requested_time TEXT NOT NULL,
  note TEXT DEFAULT '',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','quoted','accepted','rejected','declined')),
  quoted_price NUMERIC(10,2),
  quoted_time TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── Staff Holidays ──
CREATE TABLE staff_holidays (
  id TEXT PRIMARY KEY,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL,
  dates TEXT[] DEFAULT '{}',
  reason TEXT DEFAULT '',
  from_date TEXT,
  to_date TEXT
);

-- ── Message Log ──
CREATE TABLE message_log (
  id TEXT PRIMARY KEY,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  channel TEXT DEFAULT 'push',
  message TEXT DEFAULT '',
  sent_at TIMESTAMPTZ DEFAULT now(),
  recipients INTEGER DEFAULT 0
);

-- ── Campaigns ──
CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  icon TEXT DEFAULT '📧',
  title TEXT DEFAULT '',
  trigger_text TEXT DEFAULT '',
  msg TEXT DEFAULT '',
  active BOOLEAN DEFAULT true
);

-- ============================================================
-- Row Level Security Policies
-- ============================================================

ALTER TABLE salons ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ooh_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

-- Public read for salons (customers can browse)
CREATE POLICY "Salons are publicly readable" ON salons FOR SELECT USING (true);
-- Owners can update their own salon
CREATE POLICY "Owners can manage their salon" ON salons FOR ALL USING (
  auth.uid() = owner_id OR
  (auth.jwt() -> 'user_metadata' ->> 'role') = 'super_admin'
);

-- Public read for staff/services (customers need to see them)
CREATE POLICY "Staff publicly readable" ON staff FOR SELECT USING (true);
CREATE POLICY "Staff managed by owner" ON staff FOR ALL USING (
  EXISTS (SELECT 1 FROM salons WHERE salons.id = staff.salon_id AND salons.owner_id = auth.uid()) OR
  (auth.jwt() -> 'user_metadata' ->> 'role') = 'super_admin'
);

CREATE POLICY "Services publicly readable" ON services FOR SELECT USING (true);
CREATE POLICY "Services managed by owner" ON services FOR ALL USING (
  EXISTS (SELECT 1 FROM salons WHERE salons.id = services.salon_id AND salons.owner_id = auth.uid()) OR
  (auth.jwt() -> 'user_metadata' ->> 'role') = 'super_admin'
);

-- Bookings: customers can see their own, owners/staff can see salon's
CREATE POLICY "Bookings read access" ON bookings FOR SELECT USING (true);
CREATE POLICY "Bookings insert" ON bookings FOR INSERT WITH CHECK (true);
CREATE POLICY "Bookings managed by owner" ON bookings FOR UPDATE USING (
  EXISTS (SELECT 1 FROM salons WHERE salons.id = bookings.salon_id AND salons.owner_id = auth.uid()) OR
  (auth.jwt() -> 'user_metadata' ->> 'role') = 'super_admin'
);
CREATE POLICY "Bookings delete by owner" ON bookings FOR DELETE USING (
  EXISTS (SELECT 1 FROM salons WHERE salons.id = bookings.salon_id AND salons.owner_id = auth.uid()) OR
  (auth.jwt() -> 'user_metadata' ->> 'role') = 'super_admin'
);

-- Reviews: publicly readable, insertable by authenticated users
CREATE POLICY "Reviews publicly readable" ON reviews FOR SELECT USING (true);
CREATE POLICY "Reviews insertable" ON reviews FOR INSERT WITH CHECK (true);
CREATE POLICY "Reviews managed by owner" ON reviews FOR UPDATE USING (
  EXISTS (SELECT 1 FROM salons WHERE salons.id = reviews.salon_id AND salons.owner_id = auth.uid()) OR
  (auth.jwt() -> 'user_metadata' ->> 'role') = 'super_admin'
);

-- Waitlist: publicly readable, insertable
CREATE POLICY "Waitlist read" ON waitlist FOR SELECT USING (true);
CREATE POLICY "Waitlist insert" ON waitlist FOR INSERT WITH CHECK (true);
CREATE POLICY "Waitlist managed by owner" ON waitlist FOR UPDATE USING (
  EXISTS (SELECT 1 FROM salons WHERE salons.id = waitlist.salon_id AND salons.owner_id = auth.uid()) OR
  (auth.jwt() -> 'user_metadata' ->> 'role') = 'super_admin'
);
CREATE POLICY "Waitlist delete by owner" ON waitlist FOR DELETE USING (
  EXISTS (SELECT 1 FROM salons WHERE salons.id = waitlist.salon_id AND salons.owner_id = auth.uid()) OR
  (auth.jwt() -> 'user_metadata' ->> 'role') = 'super_admin'
);

-- Clients: readable by salon owner
CREATE POLICY "Clients read" ON clients FOR SELECT USING (true);
CREATE POLICY "Clients managed" ON clients FOR ALL USING (
  EXISTS (SELECT 1 FROM salons WHERE salons.id = clients.salon_id AND salons.owner_id = auth.uid()) OR
  (auth.jwt() -> 'user_metadata' ->> 'role') = 'super_admin' OR
  true -- allow inserts from customer registration
);

-- Notifications: managed by salon owner
CREATE POLICY "Notifications access" ON notifications FOR ALL USING (
  EXISTS (SELECT 1 FROM salons WHERE salons.id = notifications.salon_id AND salons.owner_id = auth.uid()) OR
  (auth.jwt() -> 'user_metadata' ->> 'role') = 'super_admin' OR
  true
);

-- Templates: managed by salon owner
CREATE POLICY "Templates access" ON notification_templates FOR ALL USING (
  EXISTS (SELECT 1 FROM salons WHERE salons.id = notification_templates.salon_id AND salons.owner_id = auth.uid()) OR
  (auth.jwt() -> 'user_metadata' ->> 'role') = 'super_admin' OR
  true
);

-- OOH Requests
CREATE POLICY "OOH requests access" ON ooh_requests FOR ALL USING (true);

-- Staff holidays
CREATE POLICY "Staff holidays access" ON staff_holidays FOR ALL USING (true);

-- Message log
CREATE POLICY "Message log access" ON message_log FOR ALL USING (true);

-- Campaigns
CREATE POLICY "Campaigns access" ON campaigns FOR ALL USING (true);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX idx_bookings_salon_date ON bookings(salon_id, date);
CREATE INDEX idx_bookings_client_email ON bookings(client_email);
CREATE INDEX idx_reviews_salon ON reviews(salon_id);
CREATE INDEX idx_waitlist_salon_date ON waitlist(salon_id, preferred_date);
CREATE INDEX idx_notifications_salon ON notifications(salon_id, created_at);
CREATE INDEX idx_clients_salon ON clients(salon_id);
