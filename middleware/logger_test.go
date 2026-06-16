package middleware

import "testing"

func TestRedactSensitiveQuery(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"status token", "/api/oauth/wechat/login/status?login_token=abc123", "/api/oauth/wechat/login/status?login_token=[redacted]"},
		{"image token keeps other params", "/api/oauth/wechat/login/qrcode/image?login_token=abc&v=1", "/api/oauth/wechat/login/qrcode/image?login_token=[redacted]&v=1"},
		{"no token untouched", "/api/foo?x=1", "/api/foo?x=1"},
		{"no query untouched", "/api/oauth/wechat/login/status", "/api/oauth/wechat/login/status"},
	}
	for _, c := range cases {
		if got := redactSensitiveQuery(c.in); got != c.want {
			t.Errorf("%s: redactSensitiveQuery(%q) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
}
