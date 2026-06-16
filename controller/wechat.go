package controller

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"
)

type wechatLoginResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    string `json:"data"`
}

func getWeChatIdByCode(code string) (string, error) {
	if code == "" {
		return "", errors.New("无效的参数")
	}
	req, err := http.NewRequest("GET", fmt.Sprintf("%s/api/wechat/user?code=%s", common.WeChatServerAddress, url.QueryEscape(code)), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", common.WeChatServerToken)
	client := http.Client{
		Timeout: 5 * time.Second,
	}
	httpResponse, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer httpResponse.Body.Close()
	var res wechatLoginResponse
	err = common.DecodeJson(httpResponse.Body, &res)
	if err != nil {
		return "", err
	}
	if !res.Success {
		return "", errors.New(res.Message)
	}
	if res.Data == "" {
		return "", errors.New("验证码错误或已过期")
	}
	return res.Data, nil
}

func WeChatAuth(c *gin.Context) {
	if !common.WeChatAuthEnabled || !common.WeChatCodeLoginEnabled {
		c.JSON(http.StatusOK, gin.H{
			"message": "管理员未开启通过微信登录以及注册",
			"success": false,
		})
		return
	}
	code := c.Query("code")
	wechatId, err := getWeChatIdByCode(code)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{
			"message": err.Error(),
			"success": false,
		})
		return
	}
	user, err := loginOrCreateUserByWeChatId(wechatId, affiliateInviteCodeFromRequest(c))
	if err != nil {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"message": err.Error(),
		})
		return
	}
	setupLogin(user, c)
}

// loginOrCreateUserByWeChatId resolves a WeChat openid to a usable account. It is shared
// by the legacy code login (WeChatAuth) and the scan-login status poll (WX-B-6): an
// already-bound openid loads the existing user, otherwise — when open registration is on —
// it provisions wechat_<nextId> and records affiliate invite attribution. The returned
// error carries a user-facing message; callers map it onto their own response envelope and
// decide how to start the session (setupLogin vs setupLoginWithOptionalTwoFA).
func loginOrCreateUserByWeChatId(wechatId string, inviteCode string) (*model.User, error) {
	user := model.User{
		WeChatId: wechatId,
	}
	if model.IsWeChatIdAlreadyTaken(wechatId) {
		if err := user.FillUserByWeChatId(); err != nil {
			return nil, err
		}
		if user.Id == 0 {
			return nil, errors.New("用户已注销")
		}
	} else {
		if !common.RegisterEnabled {
			return nil, errors.New("管理员关闭了新用户注册")
		}
		user.Username = "wechat_" + strconv.Itoa(model.GetMaxUserId()+1)
		user.DisplayName = "WeChat User"
		user.Role = common.RoleCommonUser
		user.Status = common.UserStatusEnabled

		inviteCtx, err := resolveAffiliateInviteContextForRegistration(model.DB, affiliateRegistrationAttributionInput{
			InviteCode:     inviteCode,
			RegisterMethod: service.AffiliateRegisterMethodWeChat,
			Provider:       "wechat",
		})
		if err != nil {
			return nil, err
		}
		inviterId := 0
		if inviteCtx != nil {
			inviterId = inviteCtx.InviterUserId
		}

		// Persist the inviter relation onto the new user row — InsertWithInviteeQuota
		// only credits quotas via applyInviteRewards and does NOT write the inviter_id
		// column otherwise (historical bug: rewards went out but user.inviter_id stayed
		// 0, so the inviter never showed up in 用户管理).
		user.InviterId = inviterId
		if err := user.InsertWithInviteeQuota(inviterId, affiliateInviteeQuotaForContext(inviteCtx)); err != nil {
			return nil, err
		}
		if _, err := recordAffiliateInviteAttributionForRegistration(model.DB, inviteCtx, affiliateRegistrationAttributionInput{
			InviteeUserId:  user.Id,
			RegisterMethod: service.AffiliateRegisterMethodWeChat,
			Provider:       "wechat",
			InitialQuota:   affiliateInviteInitialQuotaForContext(inviteCtx),
		}); err != nil {
			return nil, err
		}
	}

	if user.Status != common.UserStatusEnabled {
		return nil, errors.New("用户已被封禁")
	}
	return &user, nil
}

type wechatBindRequest struct {
	Code string `json:"code"`
}

func WeChatBind(c *gin.Context) {
	if !common.WeChatAuthEnabled || !common.WeChatCodeLoginEnabled {
		c.JSON(http.StatusOK, gin.H{
			"message": "管理员未开启通过微信登录以及注册",
			"success": false,
		})
		return
	}
	var req wechatBindRequest
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"message": "无效的请求",
		})
		return
	}
	code := req.Code
	wechatId, err := getWeChatIdByCode(code)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{
			"message": err.Error(),
			"success": false,
		})
		return
	}
	if model.IsWeChatIdAlreadyTaken(wechatId) {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"message": "该微信账号已被绑定",
		})
		return
	}
	session := sessions.Default(c)
	id := session.Get("id")
	user := model.User{
		Id: id.(int),
	}
	err = user.FillUserById()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	user.WeChatId = wechatId
	err = user.Update(false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
	})
	return
}
