import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.Set;

public class SnowflakeEncodingLab {
    public static void main(String[] args) {
        long epoch=Instant.parse("2026-01-01T00:00:00Z").toEpochMilli();
        long now=epoch+123456789L;
        Clock fixed=Clock.fixed(Instant.ofEpochMilli(now),ZoneOffset.UTC);
        LocalSnowflake generator=new LocalSnowflake(17,epoch,fixed,() -> {});
        Set<Long> generated=new HashSet<>();
        for (int sequence=0;sequence<4096;sequence++) {
            long id=generator.nextId();
            if (!generated.add(id)) throw new AssertionError("duplicate id");
            if (LocalSnowflake.workerOf(id)!=17) throw new AssertionError("worker");
            if (LocalSnowflake.sequenceOf(id)!=sequence) throw new AssertionError("sequence");
            if (generator.timeOf(id)!=now) throw new AssertionError("time");
        }
        try {
            generator.nextId();
            throw new AssertionError("expected capacity rejection");
        } catch (IllegalStateException expected) {
            System.out.println("4096 unique ids; overflow rejected");
        }
    }
}