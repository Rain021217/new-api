package controller

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

// wechatLoginQRCreateRateLimit enforces a per-IP minimum interval between
// WeChatLoginQRCode invocations. The map is bounded by an opportunistic
// purge inside the same Lock so a noisy client cannot grow it without
// bound; the purge threshold (5 min) is well above any realistic configured
// interval so it never evicts entries that are still actively rate-limited.
type wechatLoginQRCreateRateLimit struct {
	mu      sync.Mutex
	last    map[string]time.Time
	purgeAt time.Time
}

const wechatLoginQRCreateRateLimitPurgeAge = 5 * time.Minute

var lastWeChatQRCreatePerIP = &wechatLoginQRCreateRateLimit{last: map[string]time.Time{}}

// wechatLoginQRCreateInterval resolves the configured per-IP minimum interval, falling
// back to the documented default whenever an admin saved a non-positive value.
func wechatLoginQRCreateInterval() time.Duration {
	v := common.WeChatScanLoginCreateIntervalSecondsPerIP
	if v <= 0 {
		v = 2
	}
	return time.Duration(v) * time.Second
}

// allow returns true and records the call when the IP is allowed to create another QR.
// It also opportunistically purges entries older than wechatLoginQRCreateRateLimitPurgeAge
// to keep the map bounded — the purge runs at most once per minute under the same lock
// so it adds no extra contention compared to the simple check itself.
func (r *wechatLoginQRCreateRateLimit) allow(ip string, interval time.Duration, now time.Time) bool {
	if ip == "" {
		return true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if now.Sub(r.purgeAt) >= time.Minute {
		for k, t := range r.last {
			if now.Sub(t) > wechatLoginQRCreateRateLimitPurgeAge {
				delete(r.last, k)
			}
		}
		r.purgeAt = now
	}
	if interval > 0 {
		if prev, ok := r.last[ip]; ok && now.Sub(prev) < interval {
			return false
		}
	}
	r.last[ip] = now
	return true
}

// reset clears the in-memory state. Test helper only.
func (r *wechatLoginQRCreateRateLimit) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.last = map[string]time.Time{}
	r.purgeAt = time.Time{}
}

// Safe-floor fallbacks used when the admin has set an option to a non-positive value. We never
// trust 0/negative input — those would collapse the QR lifetime or let a single token hammer
// the external program — so each accessor below applies the documented floor.
const (
	wechatLoginDefaultMaxExpireSeconds       = 180
	wechatLoginDefaultPollIntervalSeconds    = 2
	wechatLoginDefaultMinPollIntervalSeconds = 1
)

// wechatLoginMaxExpireSeconds caps the QR validity regardless of what the external program
// reports (Q3: min(external, configured) — defaults to three minutes).
func wechatLoginMaxExpireSeconds() int {
	v := common.WeChatScanLoginTimeoutSeconds
	if v <= 0 {
		return wechatLoginDefaultMaxExpireSeconds
	}
	return v
}

// wechatLoginPollIntervalSeconds is the cadence we advise the browser to poll at.
func wechatLoginPollIntervalSeconds() int {
	v := common.WeChatScanLoginPollIntervalSeconds
	if v <= 0 {
		return wechatLoginDefaultPollIntervalSeconds
	}
	return v
}

// wechatLoginMinPollIntervalSeconds throttles how often a single token may hit the external
// program, independent of a misbehaving client.
func wechatLoginMinPollIntervalSeconds() int {
	v := common.WeChatScanLoginMinPollIntervalSeconds
	if v <= 0 {
		return wechatLoginDefaultMinPollIntervalSeconds
	}
	return v
}

type wechatLoginQRCodeRequest struct {
	AffCode string `json:"aff_code"`
}

// WeChatLoginQRCode creates a scan-login QR code, caches its image server-side and stores the
// pending session keyed by a hash of the login token. It never returns the external qrcode_url.
func WeChatLoginQRCode(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !common.WeChatAuthEnabled || !common.WeChatScanLoginEnabled {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "管理员未开启通过微信登录以及注册"})
		return
	}

	// Per-IP throttle: refuse a second QR create from the same address inside the configured
	// window. Returned as a business failure (HTTP 200, success=false) so the existing frontend
	// surfaces the message inline rather than as a hard error.
	if !lastWeChatQRCreatePerIP.allow(c.ClientIP(), wechatLoginQRCreateInterval(), time.Now()) {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "请勿频繁获取，请稍后再试"})
		return
	}

	var req wechatLoginQRCodeRequest
	// Body is optional (Q2); ignore decode errors so an empty body is allowed.
	_ = common.DecodeJson(c.Request.Body, &req)

	qr, err := service.CreateWeChatLoginQRCode()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": err.Error()})
		return
	}

	maxExpire := wechatLoginMaxExpireSeconds()
	expireSeconds := qr.ExpireSeconds
	if expireSeconds <= 0 || expireSeconds > maxExpire {
		expireSeconds = maxExpire
	}
	ttl := time.Duration(expireSeconds) * time.Second
	expiresAt := time.Now().Add(ttl).Unix()

	contentType, imageData, err := service.DownloadWeChatQRImage(qr.QRCodeURL)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "二维码生成失败，请稍后再试"})
		return
	}
	if err := service.SaveWeChatLoginImage(qr.LoginToken, contentType, imageData, ttl); err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "二维码生成失败，请稍后再试"})
		return
	}

	session := &service.WeChatLoginSession{
		SceneID:    qr.SceneID,
		Status:     service.WeChatLoginStatusPending,
		InviteCode: strings.TrimSpace(req.AffCode),
		ExpiresAt:  expiresAt,
	}
	if err := service.SaveWeChatLoginSession(qr.LoginToken, session, ttl); err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "二维码生成失败，请稍后再试"})
		return
	}

	imageURL := "/api/oauth/wechat/login/qrcode/image?login_token=" +
		url.QueryEscape(qr.LoginToken) + "&v=" + strconv.FormatInt(expiresAt, 10)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"scene_id":              qr.SceneID,
			"login_token":           qr.LoginToken,
			"qrcode_image_url":      imageURL,
			"expire_seconds":        expireSeconds,
			"poll_interval_seconds": wechatLoginPollIntervalSeconds(),
		},
	})
}

// WeChatLoginQRCodeImage proxies the cached QR image. Invalid, expired or unknown tokens all
// return a bare 404 so the endpoint cannot be used to enumerate token state.
func WeChatLoginQRCodeImage(c *gin.Context) {
	c.Header("Cache-Control", "no-store, no-cache, max-age=0")
	c.Header("X-Content-Type-Options", "nosniff")
	if !common.WeChatAuthEnabled || !common.WeChatScanLoginEnabled {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	loginToken := c.Query("login_token")
	if strings.TrimSpace(loginToken) == "" {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	session, ok, _ := service.GetWeChatLoginSession(loginToken)
	if !ok || session == nil || time.Now().Unix() > session.ExpiresAt {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	contentType, data, ok, err := service.GetWeChatLoginImage(loginToken)
	if err != nil || !ok {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	c.Data(http.StatusOK, contentType, data)
}

// WeChatLoginStatus polls one login token. While the QR is unscanned it returns
// {status:"pending"}; once the external program reports success it completes the session via
// setupLoginWithOptionalTwoFA (Q5). The external auth_code/openid are never returned raw.
func WeChatLoginStatus(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !common.WeChatAuthEnabled || !common.WeChatScanLoginEnabled {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "管理员未开启通过微信登录以及注册"})
		return
	}
	loginToken := c.Query("login_token")
	if strings.TrimSpace(loginToken) == "" {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "无效的登录令牌"})
		return
	}

	session, ok, _ := service.GetWeChatLoginSession(loginToken)
	if !ok || session == nil || time.Now().Unix() > session.ExpiresAt {
		wechatLoginRespondStatus(c, service.WeChatLoginStatusExpired)
		return
	}
	if session.BindUserId != 0 {
		// This is a bind session, polling on the login endpoint is forbidden so a logged-out
		// attacker can't accidentally (or deliberately) complete someone else's bind into a login.
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "无效的登录会话"})
		return
	}

	// Already completed — replay the login idempotently.
	if session.Consumed && session.WeChatId != "" {
		wechatLoginCompleteSession(c, session)
		return
	}

	now := time.Now().Unix()
	if session.LastPolledAt > 0 && now-session.LastPolledAt < int64(wechatLoginMinPollIntervalSeconds()) {
		wechatLoginRespondStatus(c, service.WeChatLoginStatusPending)
		return
	}

	status, err := service.QueryWeChatLoginStatus(loginToken)
	if err != nil {
		// Transport hiccup — keep the user polling rather than failing the whole login.
		wechatLoginRespondStatus(c, service.WeChatLoginStatusPending)
		return
	}

	switch status.Status {
	case service.WeChatLoginStatusSuccess:
		if status.OpenID == "" {
			wechatLoginRespondStatus(c, service.WeChatLoginStatusPending)
			return
		}
		session.WeChatId = status.OpenID
		session.Status = service.WeChatLoginStatusSuccess
		session.Consumed = true
		wechatLoginPersist(loginToken, session)
		wechatLoginCompleteSession(c, session)
	case service.WeChatLoginStatusExpired:
		wechatLoginRespondStatus(c, service.WeChatLoginStatusExpired)
	default:
		session.LastPolledAt = now
		wechatLoginPersist(loginToken, session)
		wechatLoginRespondStatus(c, service.WeChatLoginStatusPending)
	}
}

func wechatLoginRespondStatus(c *gin.Context, status string) {
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"status": status}})
}

// wechatLoginPersist saves the session for its remaining lifetime; a non-positive TTL means the
// session has already expired and is left to be reaped.
func wechatLoginPersist(loginToken string, session *service.WeChatLoginSession) {
	ttl := time.Until(time.Unix(session.ExpiresAt, 0))
	if ttl <= 0 {
		return
	}
	_ = service.SaveWeChatLoginSession(loginToken, session, ttl)
}

// wechatLoginCompleteSession resolves the WeChat openid to an account and starts the session,
// reusing the shared loginOrCreateUserByWeChatId + the optional-2FA login path.
func wechatLoginCompleteSession(c *gin.Context, session *service.WeChatLoginSession) {
	user, err := loginOrCreateUserByWeChatId(session.WeChatId, session.InviteCode)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": err.Error()})
		return
	}
	setupLoginWithOptionalTwoFA(user, c)
}

// WeChatLoginBindQRCode creates a scan-session whose successful poll binds the WeChat openid
// to the currently authenticated user (instead of starting a new login session). Auth required.
func WeChatLoginBindQRCode(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !common.WeChatAuthEnabled || !common.WeChatScanLoginEnabled {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "管理员未开启通过微信登录以及注册"})
		return
	}
	userId := c.GetInt("id")
	if userId <= 0 {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "未登录"})
		return
	}
	if !lastWeChatQRCreatePerIP.allow(c.ClientIP(), wechatLoginQRCreateInterval(), time.Now()) {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "请勿频繁获取，请稍后再试"})
		return
	}

	qr, err := service.CreateWeChatLoginQRCode()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": err.Error()})
		return
	}
	expireSeconds := qr.ExpireSeconds
	maxExpire := wechatLoginMaxExpireSeconds()
	if expireSeconds <= 0 || expireSeconds > maxExpire {
		expireSeconds = maxExpire
	}
	ttl := time.Duration(expireSeconds) * time.Second
	expiresAt := time.Now().Add(ttl).Unix()

	contentType, imageData, err := service.DownloadWeChatQRImage(qr.QRCodeURL)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "二维码生成失败，请稍后再试"})
		return
	}
	if err := service.SaveWeChatLoginImage(qr.LoginToken, contentType, imageData, ttl); err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "二维码生成失败，请稍后再试"})
		return
	}
	session := &service.WeChatLoginSession{
		SceneID:    qr.SceneID,
		Status:     service.WeChatLoginStatusPending,
		BindUserId: userId,
		ExpiresAt:  expiresAt,
	}
	if err := service.SaveWeChatLoginSession(qr.LoginToken, session, ttl); err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "二维码生成失败，请稍后再试"})
		return
	}

	imageURL := "/api/oauth/wechat/login/qrcode/image?login_token=" +
		url.QueryEscape(qr.LoginToken) + "&v=" + strconv.FormatInt(expiresAt, 10)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"scene_id":              qr.SceneID,
			"login_token":           qr.LoginToken,
			"qrcode_image_url":      imageURL,
			"expire_seconds":        expireSeconds,
			"poll_interval_seconds": wechatLoginPollIntervalSeconds(),
		},
	})
}

// WeChatLoginBindStatus polls a bind session; on the external program reporting success it
// writes the openid onto the authenticated user's wechat_id column. Auth required.
func WeChatLoginBindStatus(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !common.WeChatAuthEnabled || !common.WeChatScanLoginEnabled {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "管理员未开启通过微信登录以及注册"})
		return
	}
	userId := c.GetInt("id")
	if userId <= 0 {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "未登录"})
		return
	}
	loginToken := c.Query("login_token")
	if strings.TrimSpace(loginToken) == "" {
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "无效的登录令牌"})
		return
	}
	session, ok, _ := service.GetWeChatLoginSession(loginToken)
	if !ok || session == nil || time.Now().Unix() > session.ExpiresAt {
		wechatLoginRespondStatus(c, service.WeChatLoginStatusExpired)
		return
	}
	if session.BindUserId == 0 || session.BindUserId != userId {
		// Not a bind session, or belongs to another user — reject without leaking.
		c.JSON(http.StatusOK, gin.H{"success": false, "message": "无效的绑定会话"})
		return
	}

	if session.Consumed && session.WeChatId != "" {
		c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"status": "success"}})
		return
	}

	now := time.Now().Unix()
	if session.LastPolledAt > 0 && now-session.LastPolledAt < int64(wechatLoginMinPollIntervalSeconds()) {
		wechatLoginRespondStatus(c, service.WeChatLoginStatusPending)
		return
	}

	status, err := service.QueryWeChatLoginStatus(loginToken)
	if err != nil {
		wechatLoginRespondStatus(c, service.WeChatLoginStatusPending)
		return
	}
	switch status.Status {
	case service.WeChatLoginStatusSuccess:
		if status.OpenID == "" {
			wechatLoginRespondStatus(c, service.WeChatLoginStatusPending)
			return
		}
		if model.IsWeChatIdAlreadyTaken(status.OpenID) {
			c.JSON(http.StatusOK, gin.H{"success": false, "message": "该微信账号已被绑定"})
			return
		}
		user := model.User{Id: userId}
		if err := user.FillUserById(); err != nil {
			c.JSON(http.StatusOK, gin.H{"success": false, "message": err.Error()})
			return
		}
		user.WeChatId = status.OpenID
		if err := user.Update(false); err != nil {
			c.JSON(http.StatusOK, gin.H{"success": false, "message": err.Error()})
			return
		}
		session.WeChatId = status.OpenID
		session.Status = service.WeChatLoginStatusSuccess
		session.Consumed = true
		wechatLoginPersist(loginToken, session)
		c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"status": "success"}})
	case service.WeChatLoginStatusExpired:
		wechatLoginRespondStatus(c, service.WeChatLoginStatusExpired)
	default:
		session.LastPolledAt = now
		wechatLoginPersist(loginToken, session)
		wechatLoginRespondStatus(c, service.WeChatLoginStatusPending)
	}
}
