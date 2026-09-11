package com.jarvis.commandcenter.voice;

public final class VoiceStateMachine {
    public enum State {
        OFF,
        STARTING,
        WAITING_WAKE_WORD,
        LISTENING,
        TRANSCRIBING,
        PROCESSING,
        SPEAKING,
        WAITING_USER,
        PAUSED,
        ERROR
    }

    public enum WaitingReason {
        NONE,
        PERMISSION,
        INPUT
    }

    public static final class Snapshot {
        public final State state;
        public final WaitingReason waitingReason;
        public final String taskId;
        public final String errorCode;

        Snapshot(State state, WaitingReason waitingReason, String taskId, String errorCode) {
            this.state = state;
            this.waitingReason = waitingReason;
            this.taskId = taskId;
            this.errorCode = errorCode;
        }
    }

    private State state = State.OFF;
    private WaitingReason waitingReason = WaitingReason.NONE;
    private String taskId;
    private String errorCode;

    public synchronized void transition(State next) {
        state = next;
        if (next != State.WAITING_USER) {
            waitingReason = WaitingReason.NONE;
            taskId = null;
        }
        if (next != State.ERROR) errorCode = null;
    }

    public synchronized void waiting(WaitingReason reason, String operationTaskId) {
        state = State.WAITING_USER;
        waitingReason = reason == null ? WaitingReason.NONE : reason;
        taskId = operationTaskId;
        errorCode = null;
    }

    public synchronized void error(String code) {
        state = State.ERROR;
        errorCode = code;
        waitingReason = WaitingReason.NONE;
        taskId = null;
    }

    public synchronized Snapshot snapshot() {
        return new Snapshot(state, waitingReason, taskId, errorCode);
    }
}
