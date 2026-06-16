package service

import "testing"

func TestNormalizeQRImageContentType(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"image/png", "image/png"},
		{"image/jpeg", "image/jpeg"},
		{"IMAGE/PNG", "image/png"},
		{"image/png; charset=utf-8", "image/png"},
		{"image/svg+xml", "image/png"},
		{"text/html", "image/png"},
		{"application/javascript", "image/png"},
		{"", "image/png"},
	}
	for _, c := range cases {
		if got := normalizeQRImageContentType(c.in); got != c.want {
			t.Errorf("normalizeQRImageContentType(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
