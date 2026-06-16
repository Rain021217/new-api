package service

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
)

// wechatLoginExternalTimeout bounds every call to the external WeChat program so a
// slow upstream can never stall a login poll. Mirrors getWeChatIdByCode's 5s budget.
const wechatLoginExternalTimeout = 5 * time.Second

// Sanitized polling states surfaced to callers. They are intentionally decoupled
// from whatever string the external program returns so the controller never has to
// branch on raw upstream values.
const (
	WeChatLoginStatusSuccess = "success"
	WeChatLoginStatusPending = "pending"
	WeChatLoginStatusExpired = "expired"
)

// wechatLoginExternalError is the desensitized error surfaced when the external
// WeChat program is unreachable or returns garbage. It deliberately omits any
// upstream token, auth_code or raw payload (WX-SEC-1).
var wechatLoginExternalError = errors.New("微信扫码服务暂时不可用，请稍后再试")

// WeChatLoginQRCode is the sanitized result of creating a scan-login QR code.
// QRCodeURL is the external download address and MUST NOT be handed to the browser;
// it is fetched and proxied server-side (see WX-B-4) to avoid leaking the upstream.
type WeChatLoginQRCode struct {
	SceneID       string
	LoginToken    string
	QRCodeURL     string
	ExpireSeconds int
}

// WeChatLoginStatus is the sanitized polling result. OpenID (== wechat_id) is only
// populated on success; the external auth_code is intentionally dropped here (Q4).
type WeChatLoginStatus struct {
	Status string
	OpenID string
}

// wechatAuthorizationHeader normalizes a configured WeChat server token into a
// proper `Authorization: Bearer xxx` value. A bare token gains the `Bearer ` prefix;
// a token that already carries one (any case) is returned unchanged so we never emit
// `Bearer Bearer xxx`.
func wechatAuthorizationHeader(token string) string {
	trimmed := strings.TrimSpace(token)
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(trimmed), "bearer ") {
		return trimmed
	}
	return "Bearer " + trimmed
}

func wechatLoginEndpoint(path string) (string, error) {
	addr := strings.TrimRight(strings.TrimSpace(common.WeChatServerAddress), "/")
	if addr == "" {
		return "", errors.New("管理员未配置微信服务器地址")
	}
	return addr + path, nil
}

func newWeChatLoginRequest(method, endpoint string) (*http.Request, error) {
	req, err := http.NewRequest(method, endpoint, nil)
	if err != nil {
		return nil, err
	}
	if header := wechatAuthorizationHeader(common.WeChatServerToken); header != "" {
		req.Header.Set("Authorization", header)
	}
	return req, nil
}

type wechatCreateQRCodeResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    struct {
		SceneID       string `json:"scene_id"`
		QRCodeURL     string `json:"qrcode_url"`
		LoginToken    string `json:"login_token"`
		ExpireSeconds int    `json:"expire_seconds"`
	} `json:"data"`
}

// CreateWeChatLoginQRCode asks the external WeChat program for a fresh scan-login QR
// code. Network/timeout/parse failures and a non-success upstream body are all folded
// into the desensitized wechatLoginExternalError. The raw expire_seconds is returned
// unclamped; the API layer applies the min(external,180) cap (WX-B-3, Q3).
func CreateWeChatLoginQRCode() (*WeChatLoginQRCode, error) {
	endpoint, err := wechatLoginEndpoint("/api/wechat/create_login_qrcode")
	if err != nil {
		return nil, err
	}
	req, err := newWeChatLoginRequest(http.MethodPost, endpoint)
	if err != nil {
		return nil, err
	}
	client := http.Client{Timeout: wechatLoginExternalTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, wechatLoginExternalError
	}
	defer resp.Body.Close()
	var res wechatCreateQRCodeResponse
	if err := common.DecodeJson(resp.Body, &res); err != nil {
		return nil, wechatLoginExternalError
	}
	if !res.Success || res.Data.LoginToken == "" || res.Data.QRCodeURL == "" {
		return nil, wechatLoginExternalError
	}
	return &WeChatLoginQRCode{
		SceneID:       res.Data.SceneID,
		LoginToken:    res.Data.LoginToken,
		QRCodeURL:     res.Data.QRCodeURL,
		ExpireSeconds: res.Data.ExpireSeconds,
	}, nil
}

type wechatLoginStatusResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    struct {
		Status     string `json:"status"`
		WeChatUser struct {
			OpenID string `json:"openid"`
		} `json:"wechat_user"`
		AuthCode string `json:"auth_code"`
	} `json:"data"`
}

// QueryWeChatLoginStatus polls the external program for one login token. A non-success
// upstream body (token invalid/expired) is reported as a normal WeChatLoginStatusExpired
// result rather than an error, so callers can distinguish it from a transport failure.
// The external auth_code is never propagated to the caller (Q4).
func QueryWeChatLoginStatus(loginToken string) (*WeChatLoginStatus, error) {
	if strings.TrimSpace(loginToken) == "" {
		return nil, errors.New("无效的登录令牌")
	}
	endpoint, err := wechatLoginEndpoint("/api/wechat/login_status")
	if err != nil {
		return nil, err
	}
	req, err := newWeChatLoginRequest(http.MethodGet, endpoint)
	if err != nil {
		return nil, err
	}
	q := req.URL.Query()
	q.Set("login_token", loginToken)
	req.URL.RawQuery = q.Encode()

	client := http.Client{Timeout: wechatLoginExternalTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, wechatLoginExternalError
	}
	defer resp.Body.Close()
	var res wechatLoginStatusResponse
	if err := common.DecodeJson(resp.Body, &res); err != nil {
		return nil, wechatLoginExternalError
	}
	if !res.Success {
		// Upstream marks the token invalid/expired — a normal terminal poll state.
		return &WeChatLoginStatus{Status: WeChatLoginStatusExpired}, nil
	}
	status := res.Data.Status
	if status == "" {
		status = WeChatLoginStatusPending
	}
	return &WeChatLoginStatus{Status: status, OpenID: res.Data.WeChatUser.OpenID}, nil
}

// DownloadWeChatQRImage fetches the QR image bytes from the external program's qrcode_url so
// they can be cached and proxied; the external URL is never exposed to the browser. The body
// size is capped and the upstream content type is preserved (defaulting to image/png).
func DownloadWeChatQRImage(imageURL string) (string, []byte, error) {
	if strings.TrimSpace(imageURL) == "" {
		return "", nil, errors.New("二维码地址为空")
	}
	req, err := http.NewRequest(http.MethodGet, imageURL, nil)
	if err != nil {
		return "", nil, err
	}
	// Use the project's SSRF-protected redirect guard: qrcode_url comes from the external
	// program's response body, so a compromised/MITM upstream could 302 the fetch toward an
	// internal address otherwise.
	client := http.Client{Timeout: wechatLoginExternalTimeout, CheckRedirect: checkRedirect}
	resp, err := client.Do(req)
	if err != nil {
		return "", nil, wechatLoginExternalError
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", nil, wechatLoginExternalError
	}
	const maxQRImageBytes = 2 << 20 // 2 MiB ceiling for a QR PNG
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxQRImageBytes))
	if err != nil {
		return "", nil, wechatLoginExternalError
	}
	return normalizeQRImageContentType(resp.Header.Get("Content-Type")), data, nil
}

// normalizeQRImageContentType clamps the upstream content type to a known raster image type
// so a compromised external program cannot serve image/svg+xml or text/html from our own
// origin (stored-XSS). Anything unexpected falls back to image/png.
func normalizeQRImageContentType(contentType string) string {
	base := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	switch base {
	case "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp":
		return base
	default:
		return "image/png"
	}
}
